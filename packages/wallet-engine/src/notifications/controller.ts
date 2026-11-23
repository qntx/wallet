/**
 * `NotificationsController` — keeps one gateway push subscription per opted-in wallet and served
 * family. The secret and payload key are generated here, sealed into the subscription row, and
 * exported to the host's `PushKeyStore` so the notification extension can open deliveries while the
 * app is closed; `receive` opens the same envelopes in-app and forwards a display-only hint — the
 * activity list only changes by re-reading history.
 *
 * Every persisted row is revalidated on read; a malformed row is treated like a missing one and
 * overwritten or deleted by the next reconcile. Subscriptions survive `lock` untouched: they exist
 * precisely for the locked and closed app.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import * as z from "zod/mini";

import type { AccountTreeController } from "../accounts/controller.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { parseWith } from "../gateway/contract/endpoint.ts";
import type { PushEventKind } from "../gateway/contract/push-message.ts";
import { PUSH_ID_DOMAIN } from "../gateway/contract/push-message.ts";
import {
  PUSH_ADDRESSES_MAX,
  PUSH_AUTH_SCHEME,
  PUSH_NETWORKS_MAX,
  PUSH_FAMILIES,
  PUSH_PLATFORMS,
  pushCapabilities,
  pushPath,
  pushSubscribe,
  pushUnsubscribe,
  pushWatch,
} from "../gateway/contract/push.ts";
import type { PushFamily, PushPlatform } from "../gateway/contract/push.ts";
import type { NetworkController } from "../networks/controller.ts";
import { openPush, PUSH_KEYS_MAX } from "../push/index.ts";
import { readJson } from "../store/json.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";
import type { TransactionController } from "../transactions/controller.ts";

/**
 * Host port: where the payload keys live for the notification extension (iOS App Group keychain,
 * Android app storage). Keyed by subscription id — the token and the secret stay engine-side.
 */
export type PushKeyStore = {
  readonly put: (id: string, key: Uint8Array) => Promise<void>;
  readonly delete: (id: string) => Promise<void>;
};

/**
 * The display hint one opened delivery produces. It exists to refresh the UI; the activity list
 * changes only by re-reading history, never by trusting the hint.
 */
export type NotificationEvent = {
  readonly walletId: string;
  readonly family: PushFamily;
  readonly kind: PushEventKind;
  readonly network: string;
  readonly hash: string;
  readonly address: string;
  readonly observedAt: number;
  readonly transfer?: {
    readonly amount: string;
    readonly decimals?: number;
    readonly symbol?: string;
    readonly contract?: string;
  };
};

export type NotificationStatus = "active" | "pending" | "failed";

export type NotificationsState = {
  readonly status: "locked" | "ready";
  /** The token's platform; the token value itself never enters state. */
  readonly platform: PushPlatform | undefined;
  readonly capabilities:
    | {
        readonly platforms: ReadonlyArray<PushPlatform>;
        readonly families: ReadonlyArray<PushFamily>;
      }
    | undefined;
  /** Opted-in wallets only. */
  readonly wallets: Readonly<
    Record<string, { readonly families: Readonly<Partial<Record<PushFamily, NotificationStatus>>> }>
  >;
};

export type NotificationsControllerOptions = {
  /** `gatewayFetch`-wrapped fetch: per-family client ids are attached by the scope already. */
  readonly gateway: { readonly url: string; readonly fetch: typeof globalThis.fetch } | undefined;
  readonly openStore: () => Promise<EngineStore>;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly logger: EngineLogger;
  /** Absent → the extension cannot decrypt and shows the generic text; in-app `receive` works. */
  readonly keys: PushKeyStore | undefined;
  readonly accounts: Pick<AccountTreeController, "getState" | "store">;
  readonly networks: Pick<NetworkController, "enabled" | "store">;
  readonly transactions: Pick<TransactionController, "store">;
  readonly addresses: (walletId: string, family: PushFamily) => Promise<ReadonlyArray<string>>;
  /** Best-effort refresh of whatever the hint touches — history reloads, an assets refresh. */
  readonly reconcile: (event: NotificationEvent) => Promise<void>;
};

const TOKEN_KEY = "token";
const WALLET_PREFIX = "wallet:";
const SUB_PREFIX = "sub:";
/** A subscription is re-PUT once it is older than a week, well inside the 30-day TTL. */
const REFRESH_MS = 7 * 86_400_000;

const tokenRow = z.strictObject({
  platform: z.enum(PUSH_PLATFORMS),
  value: z.string().check(z.regex(/^[!-~]{1,4096}$/)),
});

const optInRow = z.strictObject({ enabled: z.literal(true) });

const subRow = z.strictObject({
  secret: z.string().check(z.minLength(1)),
  key: z.string().check(z.minLength(1)),
  id: z.string().check(z.regex(/^[0-9a-f]{32}$/)),
  /** The served networks the last PUT returned. */
  networks: z.array(z.string()),
  /** The networks the last PUT requested. */
  requested: z.array(z.string()),
  addresses: z.array(z.string()),
  /** The provider token the last PUT carried. */
  token: z.string().check(z.minLength(1)),
  refreshedAt: z.number(),
  expiresAt: z.number(),
  deleting: z.optional(z.boolean()),
});

type TokenRow = z.infer<typeof tokenRow>;
type SubRow = z.infer<typeof subRow> & { readonly walletId: string; readonly family: PushFamily };

const encoder = new TextEncoder();

const encode = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

const readRow = <S extends z.ZodMiniType>(
  schema: S,
  bytes: Uint8Array | undefined,
): z.output<S> | undefined =>
  bytes === undefined ? undefined : parseWith(schema, readJson(bytes));

/** `id = hex(SHA-256(utf8(PUSH_ID_DOMAIN) ‖ secret))[0..32]` — the contract's subscription id. */
const subscriptionIdOf = (secret: Uint8Array): string => {
  const domain = encoder.encode(PUSH_ID_DOMAIN);
  const input = new Uint8Array(domain.length + secret.length);
  input.set(domain);
  input.set(secret, domain.length);
  return bytesToHex(sha256(input)).slice(0, 32);
};

const sameStrings = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const dedupe = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

const toPushFamily = (value: string): PushFamily | undefined =>
  (PUSH_FAMILIES as ReadonlyArray<string>).includes(value)
    ? PUSH_FAMILIES[(PUSH_FAMILIES as ReadonlyArray<string>).indexOf(value)]
    : undefined;

/** The persisted row carries no identity — the collection key names walletId and family. */
const subToRow = (sub: SubRow): Record<string, unknown> => {
  const row: Record<string, unknown> = {
    secret: sub.secret,
    key: sub.key,
    id: sub.id,
    networks: sub.networks,
    requested: sub.requested,
    addresses: sub.addresses,
    token: sub.token,
    refreshedAt: sub.refreshedAt,
    expiresAt: sub.expiresAt,
  };
  if (sub.deleting === true) {
    row["deleting"] = true;
  }
  return row;
};

type Capabilities = NonNullable<NotificationsState["capabilities"]>;

export class NotificationsController extends Controller<NotificationsState> {
  private readonly options: NotificationsControllerOptions;
  private engineStore: EngineStore | undefined;
  private collection: EngineCollection | undefined;
  private generation = 0;
  private token: TokenRow | undefined;
  private readonly optedIn = new Set<string>();
  private readonly subs = new Map<string, SubRow>();
  /** Tx ids already POSTed this session — the gateway is idempotent, one attempt per tx. */
  private readonly watched = new Set<string>();
  private readonly statusBySub = new Map<string, NotificationStatus>();
  private unsubscribes: ReadonlyArray<() => void> = [];
  private reconcileTimer: (() => void) | undefined;
  private running = false;
  private queued = false;

  constructor(options: NotificationsControllerOptions) {
    super({
      name: "notifications",
      defaultState: () => ({
        status: "locked",
        platform: undefined,
        capabilities: undefined,
        wallets: {},
      }),
    });
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.engineStore !== undefined) {
      return;
    }
    this.engineStore = await this.options.openStore();
    this.collection = this.engineStore.collection("notifications");
    for (const key of await this.collection.list()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- rows load one at a time, in order
      const bytes = await this.collection.get(key);
      if (key === TOKEN_KEY) {
        this.token = readRow(tokenRow, bytes);
      } else if (key.startsWith(WALLET_PREFIX)) {
        if (readRow(optInRow, bytes) !== undefined) {
          this.optedIn.add(key.slice(WALLET_PREFIX.length));
        }
      } else if (key.startsWith(SUB_PREFIX)) {
        const row = readRow(subRow, bytes);
        const rest = key.slice(SUB_PREFIX.length);
        const at = rest.lastIndexOf(":");
        const family = toPushFamily(rest.slice(at + 1));
        if (row !== undefined && at > 0 && row.networks.length > 0 && family !== undefined) {
          this.subs.set(key.slice(SUB_PREFIX.length), {
            ...row,
            walletId: rest.slice(0, at),
            family,
          });
        } else if (row === undefined) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- one malformed row at a time
          await this.collection.delete(key);
        }
      }
    }
    this.update((state) => ({
      ...state,
      status: "ready",
      platform: this.token?.platform,
      wallets: this.walletStatuses(),
    }));
    let enabled = this.enabledDigest();
    this.unsubscribes = [
      this.options.accounts.store.subscribe((next, previous) => {
        if (next.wallets !== previous.wallets || next.groups !== previous.groups) {
          this.trigger();
        }
      }),
      this.options.networks.store.subscribe(() => {
        const digest = this.enabledDigest();
        if (digest !== enabled) {
          enabled = digest;
          this.trigger();
        }
      }),
      this.options.transactions.store.subscribe(() => {
        this.scanOutgoing();
      }),
    ];
    this.scanOutgoing();
    this.trigger();
  }

  lock(): void {
    this.generation += 1;
    this.reconcileTimer?.();
    this.reconcileTimer = undefined;
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
    this.token = undefined;
    this.optedIn.clear();
    this.subs.clear();
    this.watched.clear();
    this.statusBySub.clear();
    this.engineStore = undefined;
    this.collection = undefined;
    this.update(() => ({
      status: "locked",
      platform: undefined,
      capabilities: undefined,
      wallets: {},
    }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  private requireUnlocked(): EngineCollection {
    if (this.collection === undefined) {
      throw new Error("notifications requires an unlocked vault");
    }
    return this.collection;
  }

  async setToken(platform: PushPlatform, token: string): Promise<void> {
    const collection = this.requireUnlocked();
    const row: TokenRow = { platform, value: token };
    await collection.put(TOKEN_KEY, encode(row));
    this.token = row;
    this.update((state) => ({ ...state, platform }));
    this.trigger();
  }

  async enable(walletId: string): Promise<void> {
    const collection = this.requireUnlocked();
    await collection.put(`${WALLET_PREFIX}${walletId}`, encode({ enabled: true }));
    this.optedIn.add(walletId);
    for (const family of this.getState().capabilities?.families ?? PUSH_FAMILIES) {
      this.statusBySub.set(`${walletId}:${family}`, "pending");
    }
    this.update((state) => ({ ...state, wallets: this.walletStatuses() }));
    this.trigger();
  }

  async disable(walletId: string): Promise<void> {
    const collection = this.requireUnlocked();
    await collection.delete(`${WALLET_PREFIX}${walletId}`);
    this.optedIn.delete(walletId);
    this.update((state) => ({ ...state, wallets: this.walletStatuses() }));
    this.trigger();
  }

  /**
   * Opens a provider-delivered message with the device's subscription keys. `undefined` — locked,
   * unreadable, or addressed to a network/address the subscription does not cover — means the host
   * falls back to its generic copy.
   */
  async receive(message: unknown): Promise<NotificationEvent | undefined> {
    if (this.engineStore === undefined) {
      return undefined;
    }
    const active = [...this.subs.values()].filter((sub) => sub.deleting !== true);
    let keys: Uint8Array[];
    try {
      keys = active.slice(0, PUSH_KEYS_MAX).map((sub) => base64urlnopad.decode(sub.key));
    } catch {
      return undefined;
    }
    const opened = openPush(message, keys);
    if (opened === undefined) {
      return undefined;
    }
    const sub = active[opened.keyIndex];
    const { event } = opened;
    if (
      sub === undefined ||
      !sub.networks.includes(event.n) ||
      !sub.addresses.some((address) =>
        sub.family === "evm"
          ? address.toLowerCase() === event.a.toLowerCase()
          : address === event.a,
      )
    ) {
      return undefined;
    }
    const hint: NotificationEvent = {
      walletId: sub.walletId,
      family: sub.family,
      kind: event.k,
      network: event.n,
      hash: event.h,
      address: event.a,
      observedAt: event.t,
      ...(event.x === undefined
        ? {}
        : {
            transfer: {
              amount: event.x.q,
              ...(event.x.d === undefined ? {} : { decimals: event.x.d }),
              ...(event.x.s === undefined ? {} : { symbol: event.x.s }),
              ...(event.x.c === undefined ? {} : { contract: event.x.c }),
            },
          }),
    };
    try {
      await this.options.reconcile(hint);
    } catch (error) {
      this.options.logger.warn("notification reconcile failed", error);
    }
    return hint;
  }

  /** Coalesces reconcile triggers onto a zero-delay timer. */
  private trigger(): void {
    if (this.engineStore === undefined || this.reconcileTimer !== undefined) {
      return;
    }
    this.reconcileTimer = this.options.setTimer(0, () => {
      this.reconcileTimer = undefined;
      const run = async (): Promise<void> => {
        try {
          await this.reconcileLoop();
        } catch (error) {
          this.options.logger.warn("notifications reconcile failed", error);
        }
      };
      void run();
    });
  }

  private async reconcileLoop(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      const { generation } = this;
      do {
        this.queued = false;
        // oxlint-disable-next-line eslint/no-await-in-loop -- queued runs are serial, not parallel
        await this.reconcile(generation);
      } while (this.queued && this.generation === generation);
    } finally {
      this.running = false;
    }
  }

  private url(path: string): string {
    const base = this.options.gateway?.url.replace(/\/+$/, "") ?? "";
    return `${base}${path}`;
  }

  private enabledDigest(): string {
    return (PUSH_FAMILIES as ReadonlyArray<PushFamily>)
      .map((family) => `${family}:${this.options.networks.enabled(family).join(",")}`)
      .join("|");
  }

  private walletStatuses(): NotificationsState["wallets"] {
    const out: Record<
      string,
      { families: Readonly<Partial<Record<PushFamily, NotificationStatus>>> }
    > = {};
    for (const walletId of this.optedIn) {
      const families: Partial<Record<PushFamily, NotificationStatus>> = {};
      for (const [key, status] of this.statusBySub) {
        const at = key.lastIndexOf(":");
        const family = toPushFamily(key.slice(at + 1));
        if (key.slice(0, at) === walletId && family !== undefined) {
          families[family] = status;
        }
      }
      out[walletId] = { families };
    }
    return out;
  }

  private async reconcile(generation: number): Promise<void> {
    const alive = (): boolean => this.generation === generation;
    const { gateway } = this.options;
    if (gateway === undefined) {
      this.update((state) => ({ ...state, capabilities: undefined }));
      return;
    }
    const caps = await this.fetchCapabilities();
    if (!alive()) {
      return;
    }
    if (caps === undefined) {
      for (const walletId of this.optedIn) {
        for (const key of this.statusBySub.keys()) {
          if (key.slice(0, key.lastIndexOf(":")) === walletId) {
            this.statusBySub.set(key, "failed");
          }
        }
      }
      this.update((state) => ({ ...state, wallets: this.walletStatuses() }));
      return;
    }
    const desired = new Map<string, { addresses: string[]; networks: string[] }>();
    const { token } = this;
    if (token !== undefined && caps.platforms.includes(token.platform)) {
      const walletIds = new Set(
        this.options.accounts.getState().wallets.map((wallet) => wallet.walletId),
      );
      for (const walletId of this.optedIn) {
        if (!walletIds.has(walletId)) {
          continue;
        }
        for (const family of caps.families) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- one family's addresses per await
          const addresses = dedupe(await this.options.addresses(walletId, family)).slice(
            0,
            PUSH_ADDRESSES_MAX,
          );
          if (!alive()) {
            return;
          }
          const networks = this.options.networks.enabled(family).slice(0, PUSH_NETWORKS_MAX);
          if (addresses.length > 0 && networks.length > 0) {
            desired.set(`${walletId}:${family}`, {
              addresses: [...addresses],
              networks: [...networks],
            });
          }
        }
      }
    }
    const statuses = new Map<string, NotificationStatus>();
    for (const [key, want] of desired) {
      const sub = this.subs.get(key);
      const stale =
        sub === undefined ||
        sub.deleting === true ||
        sub.token !== token?.value ||
        !sameStrings(sub.addresses, want.addresses) ||
        !sameStrings(sub.requested, want.networks) ||
        this.options.now() - sub.refreshedAt >= REFRESH_MS;
      const [walletId, family] = splitSubKey(key);
      if (!stale && sub !== undefined) {
        statuses.set(key, "active");
        continue;
      }
      if (sub === undefined) {
        statuses.set(key, "pending");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- subscriptions PUT serially by design
      const outcome = await this.putSubscription(key, walletId, family, token, want, sub);
      if (!alive()) {
        return;
      }
      statuses.set(key, outcome);
    }
    for (const [key, sub] of this.subs) {
      if (desired.has(key) && statuses.get(key) === "active") {
        continue;
      }
      if (desired.has(key) && sub.deleting !== true) {
        continue;
      }
      const [, family] = splitSubKey(key);
      // oxlint-disable-next-line eslint/no-await-in-loop -- subscriptions DELETE serially by design
      await this.deleteSubscription(key, sub, family);
      if (!alive()) {
        return;
      }
    }
    this.statusBySub.clear();
    for (const [key, status] of statuses) {
      if (status === "active" || this.optedIn.has(key.slice(0, key.lastIndexOf(":")))) {
        this.statusBySub.set(key, status);
      }
    }
    this.update((state) => ({
      ...state,
      capabilities: caps,
      wallets: this.walletStatuses(),
    }));
  }

  private async fetchCapabilities(): Promise<Capabilities | undefined> {
    try {
      const response = await this.options.gateway?.fetch(this.url(pushCapabilities.path), {
        method: pushCapabilities.method,
      });
      if (response === undefined || response.status !== 200) {
        return undefined;
      }
      return parseWith(pushCapabilities.response, await response.json());
    } catch {
      return undefined;
    }
  }

  private async putSubscription(
    key: string,
    walletId: string,
    family: PushFamily,
    token: TokenRow | undefined,
    want: { addresses: string[]; networks: string[] },
    previous: SubRow | undefined,
  ): Promise<NotificationStatus> {
    const { collection } = this;
    if (token === undefined || collection === undefined) {
      return "failed";
    }
    const secret =
      previous === undefined ? this.options.random(32) : base64urlnopad.decode(previous.secret);
    const keyBytes =
      previous === undefined ? this.options.random(32) : base64urlnopad.decode(previous.key);
    const secretText = base64urlnopad.encode(secret);
    try {
      const response = await this.options.gateway?.fetch(
        this.url(pushPath(pushSubscribe.path, family)),
        {
          method: pushSubscribe.method,
          headers: {
            authorization: `${PUSH_AUTH_SCHEME} ${secretText}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            platform: token.platform,
            token: token.value,
            key: base64urlnopad.encode(keyBytes),
            networks: want.networks,
            addresses: want.addresses,
          }),
        },
      );
      if (response === undefined) {
        return "failed";
      }
      if (response.status === 404) {
        await this.removeSub(key, collection);
        return "failed";
      }
      if (response.status !== 200) {
        return "failed";
      }
      const body = parseWith(pushSubscribe.response, await response.json());
      const served = body?.networks ?? [];
      if (
        body === undefined ||
        body.id !== subscriptionIdOf(secret) ||
        !served.every((network) => want.networks.includes(network))
      ) {
        return "failed";
      }
      if (served.length === 0) {
        await this.removeSub(key, collection);
        return "failed";
      }
      const row: SubRow = {
        secret: secretText,
        key: base64urlnopad.encode(keyBytes),
        id: body.id,
        networks: served,
        requested: want.networks,
        addresses: want.addresses,
        token: token.value,
        refreshedAt: this.options.now(),
        expiresAt: body.expiresAt,
        walletId,
        family,
      };
      await collection.put(`${SUB_PREFIX}${key}`, encode(subToRow(row)));
      this.subs.set(key, row);
      try {
        await this.options.keys?.put(body.id, keyBytes);
      } catch (error) {
        this.options.logger.warn("push key export failed", error);
      }
      return "active";
    } catch {
      return "failed";
    }
  }

  private async removeSub(key: string, collection: EngineCollection): Promise<void> {
    const sub = this.subs.get(key);
    this.subs.delete(key);
    await collection.delete(`${SUB_PREFIX}${key}`);
    if (sub !== undefined) {
      try {
        await this.options.keys?.delete(sub.id);
      } catch (error) {
        this.options.logger.warn("push key removal failed", error);
      }
    }
  }

  private async deleteSubscription(key: string, sub: SubRow, family: PushFamily): Promise<void> {
    const { collection } = this;
    if (collection === undefined) {
      return;
    }
    if (sub.deleting !== true) {
      const marked: SubRow = { ...sub, deleting: true };
      this.subs.set(key, marked);
      await collection.put(`${SUB_PREFIX}${key}`, encode(subToRow(marked)));
    }
    try {
      const response = await this.options.gateway?.fetch(
        this.url(pushPath(pushUnsubscribe.path, family)),
        {
          method: pushUnsubscribe.method,
          headers: { authorization: `${PUSH_AUTH_SCHEME} ${sub.secret}` },
        },
      );
      if (response === undefined || (response.status !== 204 && response.status !== 404)) {
        return;
      }
      await this.removeSub(key, collection);
    } catch (error) {
      this.options.logger.warn("push unsubscribe failed", error);
    }
  }

  /** POSTs a watch for every submitted/pending tracked transaction of an opted-in wallet. */
  private scanOutgoing(): void {
    if (this.engineStore === undefined) {
      return;
    }
    for (const [id, tx] of Object.entries(this.options.transactions.store.getState().txs)) {
      const { hash } = tx;
      if (
        hash === undefined ||
        (tx.state !== "submitted" && tx.state !== "pending") ||
        this.watched.has(id)
      ) {
        continue;
      }
      const sub = this.subs.get(`${tx.account}:${tx.family}`);
      if (sub === undefined || sub.deleting === true || !sub.networks.includes(tx.network)) {
        continue;
      }
      this.watched.add(id);
      const post = async (): Promise<void> => {
        try {
          await this.postWatch(id, sub, tx.family, tx.network, hash);
        } catch (error) {
          this.watched.delete(id);
          this.options.logger.warn("push transaction watch failed", error);
        }
      };
      void post();
    }
  }

  private async postWatch(
    txId: string,
    sub: SubRow,
    family: PushFamily,
    network: string,
    hash: string,
  ): Promise<void> {
    const response = await this.options.gateway?.fetch(this.url(pushPath(pushWatch.path, family)), {
      method: pushWatch.method,
      headers: {
        authorization: `${PUSH_AUTH_SCHEME} ${sub.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ network, hash }),
    });
    if (response === undefined) {
      return;
    }
    if (response.status === 404) {
      // The gateway lost the subscription — force a re-PUT on the next reconcile.
      const { collection } = this;
      const stale = { ...sub, refreshedAt: 0 };
      this.subs.set(`${sub.walletId}:${family}`, stale);
      if (collection !== undefined) {
        await collection.put(`${SUB_PREFIX}${sub.walletId}:${family}`, encode(subToRow(stale)));
      }
      this.trigger();
      return;
    }
    if (!response.ok) {
      this.watched.delete(txId);
      this.options.logger.warn("push transaction watch refused");
    }
  }
}

const splitSubKey = (key: string): [string, PushFamily] => {
  const at = key.lastIndexOf(":");
  // Sub keys are always built as `${walletId}:${family}` with a valid PushFamily.
  return [key.slice(0, at), toPushFamily(key.slice(at + 1)) ?? "evm"];
};
