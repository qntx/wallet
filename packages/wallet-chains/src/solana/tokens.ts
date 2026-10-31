/**
 * Built-in SPL token table, keyed by `network` then mint address. An entry makes a
 * `transferChecked` `full`-verifiable (WD-065), so every entry must come from the issuer's own
 * published list; the source is recorded per issuer below.
 */

export type SolanaToken = {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
};

export type SolanaTokenTable = Readonly<Record<string, Readonly<Record<string, SolanaToken>>>>;

// Circle USDC on Solana mainnet (SPL Token program mint, 6 decimals), from
// https://developers.circle.com/stablecoins/usdc-contract-addresses (reviewed 2026-10-30).
const USDC: SolanaToken = Object.freeze({ symbol: "USDC", decimals: 6, name: "USD Coin" });

// Tether USDT on Solana mainnet (SPL Token program mint, 6 decimals), from
// https://tether.to/en/supported-protocols/ (reviewed 2026-10-31).
const USDT: SolanaToken = Object.freeze({ symbol: "USDT", decimals: 6, name: "Tether USD" });

export const solanaTokenTable: SolanaTokenTable = Object.freeze({
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": Object.freeze({
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: USDC,
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: USDT,
  }),
});

export const lookupSolanaToken = (
  table: SolanaTokenTable,
  network: string,
  mint: string,
): SolanaToken | undefined => table[network]?.[mint];
