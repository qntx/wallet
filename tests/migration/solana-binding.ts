import { SolanaClusterBindingError } from "@qntx/wallet-engine";
import type { SolanaBindingReason } from "@qntx/wallet-engine";

/**
 * A dApp `solana-sign` transaction whose recent blockhash or durable nonce cannot be proven to
 * belong to the session's cluster is refused before any prompt. `reason` says why; none of them is
 * a reason to sign anyway.
 */
export function bindingRefusal(error: unknown): string | undefined {
  return error instanceof SolanaClusterBindingError ? explain(error.reason) : undefined;
}

function explain(reason: SolanaBindingReason): string {
  switch (reason) {
    case "genesis-mismatch":
      return "an endpoint serves another Solana cluster";
    case "blockhash-unknown":
      return "the transaction's blockhash is not valid on this cluster — the dApp must rebuild it";
    case "nonce-account-missing":
    case "nonce-mismatch":
    case "nonce-account-in-lookup-table":
      return "the transaction's durable nonce cannot be proven on this cluster";
    case "unconfirmed":
      return "the second endpoint could not confirm the transaction's lifetime — try again";
    case "testnet-gateway-only":
      return "configure a host endpoint for this testnet";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
