/**
 * `PushObject` — one SQLite Durable Object per family (`idFromName(family)`), a thin wrapper over
 * `PushCore`: it binds `ctx.storage.sql`/`transactionSync` to the store's `Sql`, draws nonces from
 * `crypto.getRandomValues` and derives the alarm from `store.nextWake()` — the store knows every
 * due moment, so a synchronous re-derivation can never under-wake the way a read-modify-write of
 * `getAlarm`/`setAlarm` could. The family arrives with the first RPC and persists in `meta`, so
 * `alarm` can rebuild the core on a cold object.
 *
 * `upstreamFetch`/`pushRuntime` are the only seams the workerd harness needs: a subclass points
 * provider, push-service and watcher-management calls at its in-worker stub.
 *
 * `GatewayHttpError` cannot cross the RPC boundary as a class — methods return the `PushResult`
 * union and the route rethrows it.
 */
import { DurableObject } from "cloudflare:workers";

import type { PushFamily, PushSubscriptionResponse } from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "../middleware/errors.ts";
import type { WorkerEnv } from "../worker.ts";
import { pushFamilyOf } from "./backend.ts";
import type { PushResult } from "./backend.ts";
import { PushCore, UNSERVED_FAMILY, sweepExpired } from "./core.ts";
import type { IngestItem, SubscribeRequest, WatchRequest } from "./core.ts";
import { pushRuntimeFor } from "./runtime.ts";
import type { PushRuntime } from "./runtime.ts";
import { pushStore } from "./store.ts";
import type { PushStore, Sql } from "./store.ts";

export class PushObject extends DurableObject<WorkerEnv> {
  #store: PushStore | undefined;
  #core: Promise<PushCore | undefined> | undefined;
  #runtime: Promise<PushRuntime> | undefined;
  #alarmWrite: Promise<void> = Promise.resolve();

  readonly #log = (line: string): void => {
    console.log(line);
  };

  /** Every outbound call — provider RPC, APNs/FCM, the watcher's management API. */
  protected async upstreamFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init);
  }

  /** The object's secrets, watcher config and family map from the environment. */
  protected async pushRuntime(): Promise<PushRuntime> {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) =>
      this.upstreamFetch(input, init);
    return pushRuntimeFor(this.env, fetchImpl, this.#log);
  }

  #sql(): Sql {
    const { storage } = this.ctx;
    return {
      exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
      transaction: (fn) => storage.transactionSync(fn),
    };
  }

  #storage(): PushStore {
    this.#store ??= pushStore(this.#sql());
    return this.#store;
  }

  async #runtimeFor(): Promise<PushRuntime> {
    this.#runtime ??= this.pushRuntime();
    return this.#runtime;
  }

  /**
   * Re-derives the alarm from the store (`0`/past = fire now, `undefined` = disarm) and serializes
   * the write: every wake publishes the whole current schedule, so the last write is always the
   * correct minimum and a stale read can never postpone it.
   */
  #wake(): void {
    const next = this.#storage().nextWake();
    const write = async (): Promise<void> => {
      try {
        await this.#alarmWrite;
        // workerd rejects times ≤ 0; the sync-dirty sentinel is `0` = "due now" — a past or
        // clamped time still fires immediately.
        await (next === undefined
          ? this.ctx.storage.deleteAlarm()
          : this.ctx.storage.setAlarm(Math.max(1, next)));
      } catch (error) {
        this.#log(
          JSON.stringify({
            event: "push-alarm-write-error",
            name: error instanceof Error ? error.name : typeof error,
            reason: String(error),
          }),
        );
      }
    };
    this.#alarmWrite = write();
    this.ctx.waitUntil(this.#alarmWrite);
  }

  /** The core for this object's family, built once; `undefined` when push is not materialized. */
  async #coreFor(family: PushFamily): Promise<PushCore | undefined> {
    this.#core ??= (async (): Promise<PushCore | undefined> => {
      const store = this.#storage();
      const stored = store.claimFamily(family);
      if (stored !== family) {
        // idFromName(family) pins the object, so a mismatch means the name table drifted.
        this.#log(JSON.stringify({ event: "push-family-mismatch" }));
        return undefined;
      }
      const runtime = await this.#runtimeFor();
      if (runtime.materials === undefined) {
        return undefined;
      }
      return new PushCore({
        sql: this.#sql(),
        family,
        config: runtime.families[family] ?? UNSERVED_FAMILY,
        sealKey: runtime.materials.sealKey,
        senders: runtime.materials.senders,
        now: () => Date.now(),
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        wake: () => {
          this.#wake();
        },
        log: this.#log,
      });
    })();
    return this.#core;
  }

  #fail(error: unknown): PushResult<never> {
    if (error instanceof GatewayHttpError) {
      return { ok: false, status: error.status, code: error.code };
    }
    this.#log(
      JSON.stringify({
        event: "push-internal-error",
        name: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { ok: false, status: 500, code: "internal" };
  }

  async subscribe(
    family: PushFamily,
    request: SubscribeRequest,
  ): Promise<PushResult<PushSubscriptionResponse>> {
    const core = await this.#coreFor(family);
    if (core === undefined) {
      return { ok: false, status: 404, code: "unsupported" };
    }
    try {
      return { ok: true, value: await core.subscribe(request) };
    } catch (error) {
      return this.#fail(error);
    }
  }

  async unsubscribe(family: PushFamily, id: string): Promise<PushResult<undefined>> {
    const core = await this.#coreFor(family);
    if (core === undefined) {
      return { ok: false, status: 404, code: "unsupported" };
    }
    try {
      await core.unsubscribe(id);
      return { ok: true, value: undefined };
    } catch (error) {
      return this.#fail(error);
    }
  }

  async watch(family: PushFamily, request: WatchRequest): Promise<PushResult<undefined>> {
    const core = await this.#coreFor(family);
    if (core === undefined) {
      return { ok: false, status: 404, code: "unsupported" };
    }
    try {
      await core.watch(request);
      return { ok: true, value: undefined };
    } catch (error) {
      return this.#fail(error);
    }
  }

  /** Webhook observations — fed by the hook route; nothing to return. */
  async ingest(family: PushFamily, observations: IngestItem[]): Promise<PushResult<undefined>> {
    const core = await this.#coreFor(family);
    if (core === undefined) {
      return { ok: false, status: 404, code: "unsupported" };
    }
    try {
      await core.ingest(observations);
      return { ok: true, value: undefined };
    } catch (error) {
      return this.#fail(error);
    }
  }

  /**
   * The alarm: rebuild the family's core and run the pass. Without materials the crypto cannot
   * unseal anything, but the TTL sweep still runs so storage decays on schedule. Either way the
   * wake is re-derived from the store once, at the end.
   */
  override async alarm(): Promise<void> {
    const store = this.#storage();
    const stored = store.family();
    const family = stored === undefined ? undefined : pushFamilyOf(stored);
    if (family === undefined) {
      return;
    }
    const core = await this.#coreFor(family);
    if (core === undefined) {
      const runtime = await this.#runtimeFor();
      sweepExpired(
        store,
        this.#sql(),
        Date.now(),
        runtime.families[family]?.syncAddresses !== undefined,
      );
      this.#wake();
      return;
    }
    try {
      await core.alarm();
    } catch (error) {
      this.#log(
        JSON.stringify({
          event: "push-alarm-error",
          name: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }
}
