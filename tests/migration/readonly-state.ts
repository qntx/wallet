import type { DeepReadonly, WalletEngine } from "@qntx/wallet-engine";

type Tracked = DeepReadonly<ReturnType<WalletEngine["transactions"]["getState"]>["txs"][string]>;

/**
 * `getState()` snapshots are deeply frozen and typed `DeepReadonly`. Before, a host could edit a
 * snapshot in place (`delete state.txs[id]`, `rows.sort()`), silently changing what the engine
 * tracks; that now fails to compile and throws at runtime — copy first.
 */
export function newestFirst(engine: WalletEngine): Tracked[] {
  return Object.values(engine.transactions.getState().txs).toSorted(
    (a, b) => b.submittedAt - a.submittedAt,
  );
}

/** Compile-time proof only: a snapshot record cannot be written. */
export function snapshotIsReadonly(
  txs: ReturnType<WalletEngine["transactions"]["getState"]>["txs"],
): void {
  // @ts-expect-error -- snapshot records are readonly
  delete txs["tx-0"];
}
