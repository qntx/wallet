import { decodeSolanaTransaction } from "@qntx/wallet-chains/solana";
import type { WalletEngine } from "@qntx/wallet-engine";

/**
 * `solana-sign` requests carry serialized transactions exactly as the Wallet Standard passes them
 * (signature slots + message), no longer compiled messages. A host that bridges its own Solana
 * provider passes the dApp's bytes through untouched; `signedTransactions` come back as the same
 * transactions with the wallet's signature in its slot, so co-signers' signatures survive.
 */
/** Co-signers that still have to sign — a sign-and-send with any of them is refused. */
export const pendingSigners = (
  wires: ReadonlyArray<Uint8Array>,
  address: string,
): ReadonlyArray<string> =>
  wires.flatMap((wire) => decodeSolanaTransaction(wire, address).unsigned);

export async function signDappTransactions(
  engine: WalletEngine,
  origin: string,
  account: { readonly walletId: string; readonly groupIndex: number; readonly address: string },
  network: string,
  wires: ReadonlyArray<Uint8Array>,
): Promise<ReadonlyArray<Uint8Array>> {
  const pending = await engine.requests.prepare({
    method: "solana-sign",
    origin: { kind: "browser", origin },
    account,
    network,
    request: { kind: "transactions", transactions: wires, send: false },
  });
  const result = await engine.requests.outcome(pending.id);
  return "kind" in result && result.kind === "solana.transactions"
    ? (result.signedTransactions ?? [])
    : [];
}
