/**
 * `PushCore` — all push-object logic over the injected `Sql` store, with no Durable Object base
 * class so it runs on `node:sqlite` in tests. Crypto (WebCrypto, `random` nonces) and sender I/O
 * are async and always happen outside `sql.transaction`, which is synchronous.
 *
 * Every log line is a JSON object of counts and outcome classes — never an address, hash, token or
 * subscription id.
 */
import { PUSH_TTL_MS, serializePushPlaintext } from "@qntx/wallet-engine/gateway/contract";
import type {
  PushEventKind,
  PushFamily,
  PushPlatform,
  PushSubscriptionRequest,
  PushSubscriptionResponse,
  PushTransactionRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "../middleware/errors.ts";
import { base64urlBytes } from "./encoding.ts";
import type { CheckResult, PushRecord } from "./rules.ts";
import { applyCheck, newWatchRecord, observe } from "./rules.ts";
import { eventIdOf, openTarget, sealEvent, sealTarget } from "./seal.ts";
import type { PushSender } from "./senders.ts";
import { pushStore } from "./store.ts";
import type { PushStore, Sql } from "./store.ts";

export const PUSH_WATCHED_MAX = 90_000;
export const PUSH_SUBSCRIPTIONS_MAX = 100_000;
export const PUSH_RECORDS_MAX = 256;
export const CHECKS_PER_RUN = 50;
export const DELIVERIES_PER_RUN = 100;
/** An undelivered event is dropped after an hour — the same TTL seals its `expiresAt`. */
export const OUTBOX_TTL_MS = 3_600_000;
/** Delivery retry table: 30 s, 2 m, 10 m, 30 m (`Retry-After` wins when the sender names one). */
const RETRY_MS = [30_000, 120_000, 600_000, 1_800_000] as const;
const RETRY_AFTER_CAP_S = 3600;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

export type PushFamilyConfig = {
  /** Networks of this family the gateway watches — others answer `unsupported`. */
  readonly networks: ReadonlySet<string>;
  /** Canonical form of a family address, or `undefined` when malformed. */
  readonly normalizeAddress: (address: string) => string | undefined;
  /**
   * Receipt checks, same order and length as `targets`; a throw is treated as every target
   * `unknown`.
   */
  readonly verify: (
    targets: ReadonlyArray<{ network: string; hash: string }>,
  ) => Promise<ReadonlyArray<CheckResult>>;
};

export type PushCoreDeps = {
  readonly sql: Sql;
  readonly family: PushFamily;
  readonly config: PushFamilyConfig;
  readonly sealKey: CryptoKey;
  readonly senders: Partial<Record<PushPlatform, PushSender>>;
  readonly now: () => number;
  /** Nonce source — `crypto.getRandomValues` in the Worker, pinned bytes in tests. */
  readonly random: (n: number) => Uint8Array;
  /** Asks for an alarm at `atMs`; the owner schedules `min(existing, atMs)`. */
  readonly schedule: (atMs: number) => void;
  readonly log: (line: string) => void;
};

export type SubscribeRequest = { readonly id: string } & PushSubscriptionRequest;
export type WatchRequest = { readonly id: string } & PushTransactionRequest;
export type IngestItem = {
  readonly network: string;
  readonly address: string;
  readonly hash: string;
  readonly direction: "in" | "out";
  readonly tid: string;
  readonly transfer: PushRecord["transfer"];
  readonly removed: boolean;
};

export const sweepExpired = (
  store: PushStore,
  now: number,
): { readonly subscriptions: number; readonly records: number; readonly deliveries: number } => {
  let subscriptions = 0;
  for (const id of store.expiredSubscriptions(now)) {
    store.deleteSubscriptionCascade(id);
    subscriptions += 1;
  }
  let records = 0;
  for (const key of store.expiredRecords(now)) {
    store.deleteRecord(key.subscription, key.network, key.hash);
    records += 1;
  }
  let deliveries = 0;
  for (const id of store.expiredDeliveries(now)) {
    store.deleteDelivery(id);
    deliveries += 1;
  }
  return { subscriptions, records, deliveries };
};

export class PushCore {
  readonly #deps: PushCoreDeps;
  readonly #store: PushStore;

  constructor(deps: PushCoreDeps) {
    this.#deps = deps;
    this.#store = pushStore(deps.sql);
  }

  /**
   * Idempotent by id — the same secret re-PUTs to the same row. The target is sealed before the
   * transaction: SQLite writes are synchronous and cannot wrap an `await`.
   */
  async subscribe(request: SubscribeRequest): Promise<PushSubscriptionResponse> {
    const { config, senders, now, random, sealKey, family, log } = this.#deps;
    if (senders[request.platform] === undefined) {
      throw new GatewayHttpError(404, "unsupported");
    }
    const networks = request.networks.filter((n) => config.networks.has(n)).toSorted();
    if (networks.length === 0) {
      throw new GatewayHttpError(404, "unsupported");
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of request.addresses) {
      const address = config.normalizeAddress(raw);
      if (address === undefined) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      if (!seen.has(address)) {
        seen.add(address);
        normalized.push(address);
      }
    }
    const pairs = networks.flatMap((network) =>
      normalized.map((address) => ({ network, address })),
    );
    const fresh = pairs.filter((p) => !this.#store.pairWatched(p.network, p.address)).length;
    if (this.#store.watchedCount() + fresh > PUSH_WATCHED_MAX) {
      throw new GatewayHttpError(503, "unavailable");
    }
    if (
      this.#store.subscription(request.id) === undefined &&
      this.#store.subscriptionCount() >= PUSH_SUBSCRIPTIONS_MAX
    ) {
      throw new GatewayHttpError(503, "unavailable");
    }
    const expires = now() + PUSH_TTL_MS;
    const sealed = await sealTarget(
      sealKey,
      family,
      request.id,
      { p: request.platform, t: request.token, k: request.key },
      random(12),
    );
    this.#deps.sql.transaction(() => {
      this.#store.putSubscription({ id: request.id, sealed, networks, expires });
      this.#store.replaceAddresses(request.id, pairs);
    });
    this.#deps.schedule(expires);
    log(
      JSON.stringify({
        event: "push-subscribe",
        networks: networks.length,
        addresses: pairs.length,
      }),
    );
    return { id: request.id, networks, expiresAt: expires };
  }

  // oxlint-disable-next-line typescript/require-await -- the RPC surface is async; the work is sync
  async unsubscribe(id: string): Promise<undefined> {
    this.#deps.sql.transaction(() => {
      this.#store.deleteSubscriptionCascade(id);
    });
    const wake = this.#store.nextWake();
    if (wake !== undefined) {
      this.#deps.schedule(wake);
    }
    return undefined;
  }

  /** An engine-registered outgoing hash → a pending watch record checked immediately. */
  // oxlint-disable-next-line typescript/require-await -- the RPC surface is async; the work is sync
  async watch(request: WatchRequest): Promise<undefined> {
    const { now } = this.#deps;
    const subscription = this.#store.subscription(request.id);
    if (subscription === undefined) {
      throw new GatewayHttpError(404, "not-found");
    }
    if (!subscription.networks.includes(request.network)) {
      throw new GatewayHttpError(404, "unsupported");
    }
    if (this.#store.record(request.id, request.network, request.hash) !== undefined) {
      return undefined;
    }
    if (this.#store.recordCount(request.id) >= PUSH_RECORDS_MAX) {
      throw new GatewayHttpError(429, "rate-limited", RATE_LIMIT_RETRY_AFTER_SECONDS);
    }
    const at = now();
    this.#store.putRecord(request.id, newWatchRecord(request.network, request.hash, at));
    this.#deps.schedule(at);
    return undefined;
  }

  /**
   * Webhook activity (Layer 3 feeds this; tests feed it directly): each observation folds into the
   * record of every subscription watching the (network, normalized address) pair.
   */
  // oxlint-disable-next-line typescript/require-await -- the RPC surface is async; the work is sync
  async ingest(observations: ReadonlyArray<IngestItem>): Promise<undefined> {
    const { config, now } = this.#deps;
    const at = now();
    let due = false;
    for (const obs of observations) {
      const address = config.normalizeAddress(obs.address);
      if (address === undefined) {
        continue;
      }
      for (const subscription of this.#store.watching(obs.network, address)) {
        const record = this.#store.record(subscription, obs.network, obs.hash);
        const next = observe(
          record,
          {
            direction: obs.direction,
            address,
            tid: obs.tid,
            transfer: obs.transfer,
            removed: obs.removed,
          },
          obs.network,
          obs.hash,
          at,
        );
        if (next !== record) {
          this.#store.putRecord(subscription, next);
        }
        if (next.nextCheck !== undefined && next.nextCheck <= at) {
          due = true;
        }
      }
    }
    if (due) {
      this.#deps.schedule(at);
    }
    return undefined;
  }

  /**
   * The alarm pass: sweep expired rows, run the due receipt checks as one `verify` call, queue the
   * emitted events, drive the due outbox rows, then ask for the next wake.
   */
  async alarm(): Promise<void> {
    const at = this.#deps.now();
    const swept = sweepExpired(this.#store, at);
    if (swept.subscriptions + swept.records + swept.deliveries > 0) {
      this.#deps.log(JSON.stringify({ event: "push-sweep", ...swept }));
    }
    await this.#checks(at);
    await this.#deliver(at);
    const wake = this.#store.nextWake();
    if (wake !== undefined) {
      this.#deps.schedule(wake);
    }
  }

  async #checks(at: number): Promise<void> {
    const { config, log } = this.#deps;
    const due = this.#store.dueRecords(at, CHECKS_PER_RUN);
    if (due.length === 0) {
      return;
    }
    let results: ReadonlyArray<CheckResult>;
    try {
      const verified = await config.verify(
        due.map(({ record }) => ({ network: record.network, hash: record.hash })),
      );
      results =
        verified.length === due.length ? verified : due.map(() => ({ kind: "unknown" as const }));
    } catch {
      results = due.map(() => ({ kind: "unknown" as const }));
    }
    const addressSets = new Map<string, ReadonlySet<string>>();
    const stats = { checked: 0, emitted: 0, dropped: 0 };
    for (const [index, { subscription, record }] of due.entries()) {
      const row = this.#store.subscription(subscription);
      if (row === undefined) {
        this.#store.deleteRecord(subscription, record.network, record.hash);
        stats.dropped += 1;
        continue;
      }
      let addresses = addressSets.get(subscription);
      if (addresses === undefined) {
        addresses = this.#store.addressSet(subscription);
        addressSets.set(subscription, addresses);
      }
      const outcome = applyCheck(record, results[index] ?? { kind: "unknown" }, at, addresses);
      if (outcome.record === undefined) {
        this.#store.deleteRecord(subscription, record.network, record.hash);
        stats.dropped += 1;
        continue;
      }
      this.#store.putRecord(subscription, outcome.record);
      stats.checked += 1;
      if (outcome.emit === undefined || outcome.record.address === undefined) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- each record's event is sealed in order
      if (!(await this.#queue(subscription, row.sealed, outcome.record, outcome.emit, at))) {
        stats.dropped += 1;
        continue;
      }
      stats.emitted += 1;
    }
    log(JSON.stringify({ event: "push-checks", ...stats }));
  }

  /** Seals one emitted event into the outbox; `false` when the subscription had to go. */
  async #queue(
    subscription: string,
    sealed: string,
    record: PushRecord,
    emit: { readonly kind: PushEventKind; readonly generation: number },
    at: number,
  ): Promise<boolean> {
    const { sealKey, family, random, log } = this.#deps;
    const target = await openTarget(sealKey, family, subscription, sealed);
    const key = target === undefined ? undefined : base64urlBytes(target.k);
    if (target === undefined || key === undefined || key.length !== 32) {
      // A blob that no longer unseals (key rotation, corruption) cannot ever deliver.
      this.#deps.sql.transaction(() => {
        this.#store.deleteSubscriptionCascade(subscription);
      });
      log(JSON.stringify({ event: "push-unseal-failed" }));
      return false;
    }
    const { address } = record;
    if (address === undefined) {
      return false;
    }
    const plaintext = serializePushPlaintext({
      v: 1,
      k: emit.kind,
      n: record.network,
      h: record.hash,
      a: address,
      t: at,
      ...(record.tids.length === 1 && record.transfer !== undefined ? { x: record.transfer } : {}),
    });
    const eventId = await eventIdOf(key, record.network, record.hash, emit.kind, emit.generation);
    const c = await sealEvent(key, eventId, plaintext, random(12));
    this.#store.insertDelivery({
      subscription,
      event: eventId,
      c,
      attempts: 0,
      nextAt: at,
      expires: at + OUTBOX_TTL_MS,
    });
    return true;
  }

  async #deliver(at: number): Promise<void> {
    const { sealKey, family, senders, log } = this.#deps;
    const stats = { sent: 0, gone: 0, retried: 0, dropped: 0 };
    for (const row of this.#store.dueDeliveries(at, DELIVERIES_PER_RUN)) {
      const subscription = this.#store.subscription(row.subscription);
      if (subscription === undefined) {
        this.#store.deleteDelivery(row.id);
        stats.dropped += 1;
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- deliveries go out in due order
      const target = await openTarget(sealKey, family, row.subscription, subscription.sealed);
      if (target === undefined) {
        this.#deps.sql.transaction(() => {
          this.#store.deleteSubscriptionCascade(row.subscription);
        });
        log(JSON.stringify({ event: "push-unseal-failed" }));
        stats.dropped += 1;
        continue;
      }
      const sender = senders[target.p];
      if (sender === undefined) {
        this.#store.deleteDelivery(row.id);
        stats.dropped += 1;
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- deliveries go out in due order
      const outcome = await sender.send({
        token: target.t,
        eventId: row.event,
        c: row.c,
        expiresAt: row.expires,
      });
      if (outcome.kind === "sent") {
        this.#store.deleteDelivery(row.id);
        stats.sent += 1;
      } else if (outcome.kind === "gone") {
        // The provider killed the device token — the subscription is dead weight.
        this.#deps.sql.transaction(() => {
          this.#store.deleteSubscriptionCascade(row.subscription);
        });
        stats.gone += 1;
      } else if (outcome.kind === "drop") {
        this.#store.deleteDelivery(row.id);
        stats.dropped += 1;
        log(JSON.stringify({ event: "push-drop", reason: outcome.reason }));
      } else {
        const after =
          outcome.afterSeconds === undefined
            ? (RETRY_MS[Math.min(row.attempts, RETRY_MS.length - 1)] ?? 1_800_000)
            : Math.min(outcome.afterSeconds, RETRY_AFTER_CAP_S) * 1000;
        const nextAt = at + after;
        if (nextAt >= row.expires) {
          this.#store.deleteDelivery(row.id);
          stats.dropped += 1;
        } else {
          this.#store.updateDelivery(row.id, row.attempts + 1, nextAt);
          stats.retried += 1;
        }
      }
    }
    if (stats.sent + stats.gone + stats.retried + stats.dropped > 0) {
      log(JSON.stringify({ event: "push-deliver", ...stats }));
    }
  }
}

export const UNSERVED_FAMILY: PushFamilyConfig = {
  networks: new Set<string>(),
  normalizeAddress: () => undefined,
  verify: async (targets) => {
    await Promise.resolve();
    return targets.map(() => ({ kind: "unknown" as const }));
  },
};
