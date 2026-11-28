import type { RateWindow, SpendCap } from "../config/accounts.ts";

/** The rate windows and spend caps one account is limited by — `Pick<Account, "rate" | "cap">`. */
export type BudgetLimits = {
  readonly rate: ReadonlyArray<RateWindow>;
  readonly cap?: SpendCap;
};

/**
 * Bucket and spend state for one account: one level per rate window, in the same order; `at` the
 * Unix-ms instant the levels were last refilled; `spend` the granted units in hour slots (checked
 * against `cap.day`) and UTC-day slots (against `cap.month`) — recorded whether or not the account
 * currently carries the cap, so a deploy that adds one sees the spend already made. Mutated in
 * place by {@link grant} so a caller's stored reference stays current.
 */
export type BucketState = {
  levels: number[];
  at: number;
  spend: {
    hours: Array<[slot: number, units: number]>;
    days: Array<[slot: number, units: number]>;
  };
};

export type GrantResult =
  | { readonly ok: true; readonly granted: number }
  | { readonly ok: false; readonly retryAfterSeconds: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** `cap.day` counts the current hour and the 24 before it — 25 hour slots cover any 24 h interval. */
const DAY_HOUR_SLOTS = 25;
/** `cap.month` counts the current UTC day and the 31 before it — 32 slots cover any 31-day month. */
const MONTH_DAY_SLOTS = 32;

/** An account's buckets start full, with nothing spent. */
export const fullBuckets = (limits: BudgetLimits, at: number): BucketState => ({
  levels: limits.rate.map((window) => window.units),
  at,
  spend: { hours: [], days: [] },
});

/**
 * The seconds until entries totalling `excess` units age out of the checked range, scanning `slots`
 * oldest first. A slot leaves the range of `width` slots ending at the current one when the current
 * slot index reaches `slot + width`.
 */
const expiryWait = (
  slots: ReadonlyArray<readonly [slot: number, units: number]>,
  excess: number,
  width: number,
  slotMs: number,
  now: number,
): number => {
  const sorted = [...slots].toSorted((a, b) => a[0] - b[0]);
  let aged = 0;
  for (const [slot, units] of sorted) {
    aged += units;
    if (aged >= excess) {
      return Math.max(1, Math.ceil(((slot + width) * slotMs - now) / 1000));
    }
  }
  // The spend inside the range cannot cover the excess — unreachable: excess ≤ the summed spend.
  return 1;
};

/**
 * The cap headroom and, on refusal, the wait until enough old slots age out for `min` to fit.
 * `slots` is already pruned to the checked range.
 */
const capCheck = (
  cap: number | undefined,
  slots: ReadonlyArray<readonly [number, number]>,
  width: number,
  slotMs: number,
  now: number,
  min: number,
): { readonly headroom: number; readonly wait: number | undefined } => {
  if (cap === undefined) {
    return { headroom: Number.POSITIVE_INFINITY, wait: undefined };
  }
  const spent = slots.reduce((sum, [, units]) => sum + units, 0);
  const headroom = cap - spent;
  if (min > cap) {
    // A take larger than the cap can never be granted; the answer still carries a finite wait.
    return { headroom, wait: Math.floor((width - 1) * (slotMs / 1000)) };
  }
  if (headroom >= min) {
    return { headroom, wait: undefined };
  }
  return { headroom, wait: expiryWait(slots, min - headroom, width, slotMs, now) };
};

/**
 * Draws from a multi-window token bucket under hard sliding spend caps. Levels refill continuously
 * at `units / seconds` per second, clamped to capacity. `cap.day` bounds the units granted inside
 * the current hour and the 24 before it (25 hour slots — any 24 h interval touches at most that
 * many); `cap.month` the current UTC day and the 31 before it (32 day slots — any 31-day month,
 * whatever its start day). Slots older than the range are pruned on every grant.
 *
 * A grant needs every window to hold at least `min` and every cap to have at least `min` headroom;
 * it then draws `min(want, smallest level, smallest cap headroom)` from all windows and the caps —
 * `want` above that is a partial lease, never an over-spend. A refusal reports the seconds until
 * the tightest constraint admits `min` again (for a cap, when enough old slots age out), at least
 * one second. `min` above a window's capacity or a cap can never be granted, but the answer still
 * carries a finite wait.
 *
 * Granted units are recorded in the hour and day slots whether or not the account currently carries
 * the matching cap: a deploy that adds or re-adds a cap must see the spend already made — a deploy
 * never refills a cap.
 */
export function grant(
  limits: BudgetLimits,
  state: BucketState,
  now: number,
  want: number,
  min: number,
): GrantResult {
  const elapsedSeconds = Math.max(0, (now - state.at) / 1000);
  state.at = now;
  for (const [index, window] of limits.rate.entries()) {
    const level = (state.levels[index] ?? 0) + (window.units / window.seconds) * elapsedSeconds;
    state.levels[index] = Math.min(window.units, level);
  }

  const hourSlot = Math.floor(now / HOUR_MS);
  const daySlot = Math.floor(now / DAY_MS);
  state.spend.hours = state.spend.hours.filter(([slot]) => slot > hourSlot - DAY_HOUR_SLOTS);
  state.spend.days = state.spend.days.filter(([slot]) => slot > daySlot - MONTH_DAY_SLOTS);

  const day = capCheck(limits.cap?.day, state.spend.hours, DAY_HOUR_SLOTS, HOUR_MS, now, min);
  const month = capCheck(limits.cap?.month, state.spend.days, MONTH_DAY_SLOTS, DAY_MS, now, min);

  const smallest = Math.min(...state.levels);
  if (smallest < min || day.wait !== undefined || month.wait !== undefined) {
    const waits = limits.rate.map((window, index) =>
      Math.ceil(((min - (state.levels[index] ?? 0)) * window.seconds) / window.units),
    );
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, ...waits, day.wait ?? 0, month.wait ?? 0),
    };
  }
  const granted = Math.min(want, smallest, day.headroom, month.headroom);
  for (const index of limits.rate.keys()) {
    state.levels[index] = (state.levels[index] ?? 0) - granted;
  }
  const hourEntry = state.spend.hours.find(([slot]) => slot === hourSlot);
  if (hourEntry === undefined) {
    state.spend.hours.push([hourSlot, granted]);
  } else {
    hourEntry[1] += granted;
  }
  const dayEntry = state.spend.days.find(([slot]) => slot === daySlot);
  if (dayEntry === undefined) {
    state.spend.days.push([daySlot, granted]);
  } else {
    dayEntry[1] += granted;
  }
  return { ok: true, granted };
}
