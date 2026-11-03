import { SOLANA_NETWORKS } from "../networks/registry.ts";

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

const solanaId = (name: string): string => {
  const entry = SOLANA_NETWORKS.find((n) => n.name === name);
  if (entry === undefined) {
    throw new Error(`no solana network named ${name} in the registry`);
  }
  return entry.id;
};

/**
 * The Wallet Standard short chain ids to the registry's CAIP-2 genesis-hash ids, derived from the
 * solana network registry by name.
 */
export const SOLANA_CHAIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  "solana:mainnet": solanaId("Solana"),
  "solana:devnet": solanaId("Solana Devnet"),
});
