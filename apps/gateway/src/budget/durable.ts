import { DurableObject } from "cloudflare:workers";

import type { BudgetWindow } from "../config/accounts.ts";
import type { BucketState } from "./bucket.ts";
import { fullBuckets, grant } from "./bucket.ts";

export type LeaseResult =
  | { readonly ok: true; readonly granted: number }
  | { readonly ok: false; readonly retryAfterSeconds: number };

/** The sync-KV key under which an account's bucket levels persist. */
const LEVELS_KEY = "levels";

/**
 * One provider account's authoritative budget. The Workers rate-limit binding counts per Cloudflare
 * location — "these counts do not combine into one worldwide limit"
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — and the same
 * page's "Strict limits" section prescribes routing an upstream credential's quota through one
 * Durable Object. One object per account (`idFromName`), state in the SQLite-backed sync KV so an
 * evicted object does not reset to full. Windows arrive per call; the object holds no config.
 */
export class ProviderBudgetObject extends DurableObject {
  lease(windows: ReadonlyArray<BudgetWindow>, want: number, min: number): LeaseResult {
    // SQLite storage operations are synchronous and do not yield the event loop, so they execute
    // atomically without blockConcurrencyWhile
    // (https://developers.cloudflare.com/durable-objects/api/state/) — no await separates the KV
    // read from the write.
    const now = Date.now();
    const stored = this.ctx.storage.kv.get<BucketState>(LEVELS_KEY);
    const state =
      stored !== undefined && stored.levels.length === windows.length
        ? stored
        : fullBuckets(windows, now);
    const result = grant(windows, state, now, want, min);
    this.ctx.storage.kv.put(LEVELS_KEY, state);
    return result;
  }
}
