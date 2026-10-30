/**
 * Built-in ERC-20 token table, keyed by `chainId` then checksummed address. Intentionally EMPTY in
 * this layer — real entries need official-source review (C6). Tests exercise the `full` ERC-20 path
 * through `evmTokenTable`, which is exported for the kernel/test callers only via the `/evm` entry
 * point.
 */

export type EvmToken = {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
};

export type EvmTokenTable = Readonly<Record<string, Readonly<Record<string, EvmToken>>>>;

const EMPTY_TABLE: EvmTokenTable = Object.freeze({});

/** The built-in table — empty until official-source review lands the entries. */
export const evmTokenTable: EvmTokenTable = EMPTY_TABLE;

export const lookupEvmToken = (
  table: EvmTokenTable,
  chainId: number,
  address: string,
): EvmToken | undefined => table[String(chainId)]?.[address];
