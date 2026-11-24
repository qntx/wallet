import { ChainError } from "@qntx/wallet-chains";

/** Why a message's lifetime could not be bound to the configured cluster. */
export type SolanaBindingReason =
  | "genesis-mismatch"
  | "blockhash-unknown"
  | "nonce-account-missing"
  | "nonce-mismatch"
  | "nonce-account-in-lookup-table"
  | "unconfirmed"
  | "testnet-gateway-only";

/**
 * A `solana-sign` lifetime that cannot be proven to belong to the session's cluster. `code` is
 * `invalid-request` like every other binding refusal; `reason` names which check failed.
 */
export class SolanaClusterBindingError extends ChainError {
  readonly reason: SolanaBindingReason;

  constructor(reason: SolanaBindingReason, message: string) {
    super("invalid-request", message);
    this.name = "SolanaClusterBindingError";
    this.reason = reason;
  }
}

/** Why a transaction's TaPoS reference could not be bound to this network. */
export type TronBindingReason = "reference-block-unknown";

/**
 * A `tron-sign` transaction whose reference block cannot be proven to belong to this network —
 * `code` is `invalid-request` like every other binding refusal; `reason` names which check failed.
 */
export class TronBindingError extends ChainError {
  readonly reason: TronBindingReason;

  constructor(reason: TronBindingReason, message: string) {
    super("invalid-request", message);
    this.name = "TronBindingError";
    this.reason = reason;
  }
}
