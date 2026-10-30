/**
 * Built-in SPL token table, keyed by `network` then mint address. Intentionally EMPTY in this layer
 * — real entries need official-source review (C6). Tests exercise the known-mint path through an
 * internal table parameter that is not exported from the package entry points.
 */

export type SolanaToken = {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
};

export type SolanaTokenTable = Readonly<Record<string, Readonly<Record<string, SolanaToken>>>>;

const EMPTY_TABLE: SolanaTokenTable = Object.freeze({});

export const solanaTokenTable: SolanaTokenTable = EMPTY_TABLE;

export const lookupSolanaToken = (
  table: SolanaTokenTable,
  network: string,
  mint: string,
): SolanaToken | undefined => table[network]?.[mint];
