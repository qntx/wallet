/**
 * `PushObject` — one SQLite Durable Object per family (`idFromName(family)`), a thin wrapper over
 * `PushCore`: it binds `ctx.storage.sql`/`transactionSync` to the store's `Sql`, draws nonces from
 * `crypto.getRandomValues` and schedules the alarm to the earliest due moment. The family arrives
 * with the first RPC and persists in `meta`, so `alarm` can rebuild the core on a cold object.
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
import { pushFamilies, pushMaterials } from "./runtime.ts";
import { pushStore } from "./store.ts";
import type { PushStore, Sql } from "./store.ts";

export class PushObject extends DurableObject<WorkerEnv> {
  #store: PushStore | undefined;
  #core: Promise<PushCore | undefined> | undefined;

  readonly #log = (line: string): void => {
    console.log(line);
  };

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

  /** Asks for a wake no later than `at`; a later alarm only over-wakes, never under-wakes. */
  #schedule(at: number): void {
    this.ctx.waitUntil(
      (async () => {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || at < current) {
          await this.ctx.storage.setAlarm(at);
        }
      })(),
    );
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
      const materials = await pushMaterials(
        this.env,
        async (input, init) => fetch(input, init),
        () => Date.now(),
      );
      if (materials === undefined) {
        return undefined;
      }
      return new PushCore({
        sql: this.#sql(),
        family,
        config: pushFamilies[family] ?? UNSERVED_FAMILY,
        sealKey: materials.sealKey,
        senders: materials.senders,
        now: () => Date.now(),
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        schedule: (at) => {
          this.#schedule(at);
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

  /** Webhook observations — fed by the Layer 3 hook route; nothing to return. */
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
   * unseal anything, but the TTL sweep still runs so storage decays on schedule.
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
      sweepExpired(store, Date.now());
      const wake = store.nextWake();
      if (wake !== undefined) {
        this.#schedule(wake);
      }
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
