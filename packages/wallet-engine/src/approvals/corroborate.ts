/**
 * The corroborate rule — the inventory's one trust invariant. A discovery source yields candidate
 * keys; a row exists only because a primary chain read at a stated height showed it active, and it
 * is `verified` only when a second upstream read the same thing at the same height and agreed.
 * Disagreement is never averaged: an inactive or contradictory second read removes the row
 * (`disputed`), and a failed second read leaves it unverified rather than trusted.
 */
import type { Independent } from "../networks/controller.ts";

/** What one side read at the shared height. */
export type ReadResult<V> =
  | { readonly kind: "active"; readonly value: V }
  | { readonly kind: "inactive" };

/** The corroborate verdict for one probed key. */
export type Corroborated<V> =
  /** The row is shown; `verified` records whether a second upstream proved it. */
  | { readonly kind: "shown"; readonly value: V; readonly verified: boolean }
  /** The primary read shows nothing there — the candidate is dropped. */
  | { readonly kind: "dropped" }
  /** The two reads contradict each other — the row is hidden, not shown either way. */
  | { readonly kind: "disputed" }
  /** The primary read itself failed. */
  | { readonly kind: "unread" };

/**
 * One candidate through both reads. `merge` returns the row values to show — numeric fields at the
 * weaker (smaller) of the two answers — or `undefined` when the reads disagree on identity fields
 * (spender, delegate, address). `unavailable`/`not-needed` never call `independentRead`.
 */
export const corroborate = async <C, V>(
  independent: Independent<C>,
  primaryRead: () => ReadResult<V> | Promise<ReadResult<V>>,
  independentRead: (client: C) => ReadResult<V> | Promise<ReadResult<V>>,
  merge: (primary: V, secondary: V) => V | undefined,
): Promise<Corroborated<V>> => {
  let primary: ReadResult<V>;
  try {
    primary = await primaryRead();
  } catch {
    return { kind: "unread" };
  }
  if (primary.kind === "inactive") {
    return { kind: "dropped" };
  }
  if (independent.kind === "not-needed") {
    return { kind: "shown", value: primary.value, verified: true };
  }
  if (independent.kind === "unavailable") {
    return { kind: "shown", value: primary.value, verified: false };
  }
  let secondary: ReadResult<V>;
  try {
    secondary = await independentRead(independent.client);
  } catch {
    return { kind: "shown", value: primary.value, verified: false };
  }
  if (secondary.kind === "inactive") {
    return { kind: "disputed" };
  }
  const merged = merge(primary.value, secondary.value);
  return merged === undefined
    ? { kind: "disputed" }
    : { kind: "shown", value: merged, verified: true };
};

/** The smaller of two decimal-string amounts; equal inputs return either. */
export const minAmount = (a: string, b: string): string => (BigInt(a) <= BigInt(b) ? a : b);
