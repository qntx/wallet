import { DurableObject } from "cloudflare:workers";

import type { BucketState, BudgetLimits } from "./bucket.ts";
import { fullBuckets, grant } from "./bucket.ts";

export type LeaseResult =
  | { readonly ok: true; readonly granted: number }
  | { readonly ok: false; readonly retryAfterSeconds: number };

/** The sync-KV key under which an account's bucket and spend state persists. */
const LEVELS_KEY = "levels";

/**
 * The stored state for this lease: a state whose rate-window count matches is authoritative; one
 * whose count differs (a deploy changed the rows) restarts its levels full but KEEPS the spend — a
 * deploy must never refill a spent cap. A state without `spend` predates caps; pre-1.0 it is
 * discarded.
 */
const stateFor = (
  stored: BucketState | undefined,
  limits: BudgetLimits,
  now: number,
): BucketState => {
  if (stored === undefined || stored.spend === undefined) {
    return fullBuckets(limits, now);
  }
  if (stored.levels.length !== limits.rate.length) {
    return { ...fullBuckets(limits, now), spend: stored.spend };
  }
  return stored;
};

/**
 * One provider account's authoritative budget. The Workers rate-limit binding counts per Cloudflare
 * location — "these counts do not combine into one worldwide limit"
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — and the same
 * page's "Strict limits" section prescribes routing an upstream credential's quota through one
 * Durable Object. One object per account (`idFromName`), state in the SQLite-backed sync KV so an
 * evicted object does not reset to full. Windows and caps arrive per call; the object holds no
 * config.
 */
export class ProviderBudgetObject extends DurableObject {
  lease(limits: BudgetLimits, want: number, min: number): LeaseResult {
    // SQLite storage operations are synchronous and do not yield the event loop, so they execute
    // atomically without blockConcurrencyWhile
    // (https://developers.cloudflare.com/durable-objects/api/state/) — no await separates the KV
    // read from the write.
    const now = Date.now();
    const state = stateFor(this.ctx.storage.kv.get<BucketState>(LEVELS_KEY), limits, now);
    const result = grant(limits, state, now, want, min);
    this.ctx.storage.kv.put(LEVELS_KEY, state);
    return result;
  }
}
