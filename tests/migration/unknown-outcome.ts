import type { TrackedTransaction, TxState, WalletEngine } from "@qntx/wallet-engine";

const ENDED: ReadonlySet<TxState> = new Set(["failed", "rejected", "dropped", "replaced"]);

/**
 * A broadcast whose outcome is unknown (timeout, 5xx, transport error) no longer rejects: `approve`
 * resolves with a `submitted` transaction tracked under its own hash, and the engine rebroadcasts
 * the same bytes. Never offer "try again" for it — a second send could pay twice. Only a definitive
 * refusal rejects, and the transaction is then `failed`. `confirmed` is no longer terminal either:
 * a transaction in a block (`tx.block` set) stays tracked until `final` — EVM `finalized` tag, six
 * Bitcoin confirmations, Solana `finalized` commitment — and a reorg puts it back to `submitted`,
 * so show it pending again until `final`.
 */
export function watchUntilSettled(
  engine: WalletEngine,
  txId: string,
  onChange: (tx: TrackedTransaction) => void,
): () => void {
  const stop = engine.transactions.store.subscribe((state) => {
    const tx = state.txs[txId];
    if (tx === undefined) {
      return;
    }
    onChange(tx);
    if (tx.block === undefined ? ENDED.has(tx.state) : tx.final === true) {
      stop();
    }
  });
  return stop;
}

/** The signed bytes live on `raw` for every family (0.13.0 kept them on `evm.raw`). */
export function signedBytes(tx: TrackedTransaction): string | undefined {
  // oxlint-disable typescript/no-unsafe-assignment -- demonstrates the removed evm.raw field
  // @ts-expect-error -- `evm.raw` moved to `raw`
  const before: string | undefined = tx.evm?.raw;
  // oxlint-enable typescript/no-unsafe-assignment
  return tx.raw ?? before;
}
