/** Wallet-facing activity entry: one transaction per chain or provider source, merged per group. */

export type HistoryStatus = "pending" | "confirmed" | "failed" | "dropped" | "replaced";

export type HistoryFlag =
  | "zero-value-transfer"
  | "token-impersonation"
  | "suspicious-token-symbol"
  | "lookalike-counterparty"
  | "chain-mismatch"
  /** The outcome is genuinely unknown and no evidence can still arrive — user-archived. */
  | "unresolved";

export type HistoryChange = {
  readonly direction: "in" | "out";
  /** EVM "native" | checksummed token; Solana "lamports" | mint; Bitcoin/Spark "sats". */
  readonly asset: string;
  /** Non-negative base units; zero is kept — a poisoning transfer stays visible, flagged. */
  readonly amount: string;
  readonly decimals?: number;
  readonly symbol?: string;
  readonly tokenId?: string;
  /** Native or in the built-in token table: symbol and decimals are trusted. */
  readonly listed: boolean;
};

export type HistoryEntry = {
  /** `${network}:${hash}` */
  readonly id: string;
  readonly family: "evm" | "solana" | "bitcoin" | "tron" | "spark";
  /** CAIP-2; Spark uses `spark:${SparkNetwork}`. */
  readonly network: string;
  /** Tx hash / signature / txid / Spark transfer id. */
  readonly hash: string;
  /** All changes in / all out / none / both. */
  readonly direction: "in" | "out" | "self" | "mixed";
  /** Never the group's own addresses. */
  readonly counterparties: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<HistoryChange>;
  /** Native base units this wallet paid. */
  readonly fee?: string;
  readonly status: HistoryStatus;
  /** Milliseconds since the epoch. */
  readonly timestamp?: number;
  /** Block / slot / height. */
  readonly block?: number;
  /** Read from the ledger itself, or a provider claim confirmed against it. */
  readonly verified: boolean;
  readonly origin: "chain" | "provider" | "local";
  readonly flags: ReadonlyArray<HistoryFlag>;
  /** The TransactionController id when this wallet sent it. */
  readonly localTxId?: string;
};
