/**
 * The Wallet Standard (`window.solana` / `registerWallet`) handler — the bridge routes `provider:
 * "solana"` messages here.
 */
export type SolanaRequest = {
  readonly method: string;
  readonly params?: unknown;
};

export type SolanaHandler = {
  readonly handle: (origin: string, request: SolanaRequest) => Promise<unknown>;
};

/** The Wallet Standard short chain ids to the registry's CAIP-2 genesis-hash ids. */
export const SOLANA_CHAIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  "solana:mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana:devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
});
