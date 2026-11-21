import type { BudgetWindow } from "../config/accounts.ts";

/**
 * Token-bucket state for one account: one level per budget window, in the same order. `at` is the
 * Unix-ms instant the levels were last refilled. Mutated in place by {@link grant} so a caller's
 * stored reference stays current.
 */
export type BucketState = {
  levels: number[];
  at: number;
};

export type GrantResult =
  | { readonly ok: true; readonly granted: number }
  | { readonly ok: false; readonly retryAfterSeconds: number };

/** An account's bucket starts full. */
export const fullBuckets = (windows: ReadonlyArray<BudgetWindow>, at: number): BucketState => ({
  levels: windows.map((window) => window.units),
  at,
});

/**
 * Draws from a multi-window token bucket. Levels refill continuously at `units / seconds` per
 * second, clamped to capacity. A grant needs every window to hold at least `min`; it then draws
 * `min(want, smallest level)` from all windows — `want` above the smallest level is a partial
 * lease, never an over-spend. A refusal reports the seconds until the tightest window reaches `min`
 * again, at least 1. `min` above a window's capacity can never be granted, but the answer still
 * carries a finite wait.
 */
export function grant(
  windows: ReadonlyArray<BudgetWindow>,
  state: BucketState,
  now: number,
  want: number,
  min: number,
): GrantResult {
  const elapsedSeconds = Math.max(0, (now - state.at) / 1000);
  state.at = now;
  for (const [index, window] of windows.entries()) {
    const level = (state.levels[index] ?? 0) + (window.units / window.seconds) * elapsedSeconds;
    state.levels[index] = Math.min(window.units, level);
  }
  const smallest = Math.min(...state.levels);
  if (smallest < min) {
    const waits = windows.map((window, index) =>
      Math.ceil(((min - (state.levels[index] ?? 0)) * window.seconds) / window.units),
    );
    return { ok: false, retryAfterSeconds: Math.max(1, ...waits) };
  }
  const granted = Math.min(want, smallest);
  for (const index of windows.keys()) {
    state.levels[index] = (state.levels[index] ?? 0) - granted;
  }
  return { ok: true, granted };
}
