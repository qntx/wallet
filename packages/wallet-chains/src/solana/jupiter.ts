import { getU16Decoder, getU32Decoder, getU64Decoder } from "@solana/codecs";

import type { ParsedSolanaMessage } from "./message.ts";
import { resolveAccountIndex } from "./message.ts";

/** Jupiter's swap program — recognised by program id like Lido's upgradeable proxies. */
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const ROUTE_V2 = Uint8Array.from([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14]);
const SHARED_ROUTE_V2 = Uint8Array.from([0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9]);

const u16 = getU16Decoder();
const u32 = getU32Decoder();
const u64 = getU64Decoder();

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

export type JupiterSwap = {
  readonly authority: string;
  readonly sourceMint: string;
  readonly destinationMint: string;
  readonly destinationTokenProgram: string;
  /**
   * The token account the user receives into — `user_destination_token_account` when the optional
   * destination account field carries the program id (None).
   */
  readonly destinationAccount: string;
  readonly inAmount: bigint;
  readonly quotedOut: bigint;
  readonly slippageBps: number;
  readonly platformFeeBps: number;
};

/**
 * `route_v2` / `shared_accounts_route_v2`: the fixed scalar prefix must be exact and the trailing
 * `route_plan` vector must declare enough remaining bytes (each step is ≥ 5 bytes on the wire). The
 * route steps themselves stay opaque — the intent only shows the inputs and the floor.
 */
export const decodeJupiterIx = (
  parsed: ParsedSolanaMessage,
  ix: { readonly accountIndices: ReadonlyArray<number>; readonly data: Uint8Array },
  lookups: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
): JupiterSwap | undefined => {
  const { data } = ix;
  const account = (i: number): string | undefined => {
    const index = ix.accountIndices[i];
    return index === undefined ? undefined : resolveAccountIndex(parsed, index, lookups);
  };
  const require = (i: number): string => account(i) ?? "";
  const planWellFormed = (offset: number): boolean => {
    if (data.length < offset + 4) {
      return false;
    }
    const count = u32.decode(data, offset);
    return data.length >= offset + 4 + count * 5;
  };
  const scalars = (
    o: number,
  ): Omit<
    JupiterSwap,
    | "authority"
    | "sourceMint"
    | "destinationMint"
    | "destinationTokenProgram"
    | "destinationAccount"
  > => ({
    inAmount: u64.decode(data, o),
    quotedOut: u64.decode(data, o + 8),
    slippageBps: u16.decode(data, o + 16),
    platformFeeBps: u16.decode(data, o + 18),
  });
  if (startsWith(data, ROUTE_V2)) {
    /* scalars: u64 + u64 + u16 + u16 + u16 = 22 bytes after the 8-byte discriminator. */
    if (ix.accountIndices.length < 10 || !planWellFormed(30)) {
      return undefined;
    }
    const optionalDest = require(7);
    return {
      authority: require(0),
      sourceMint: require(3),
      destinationMint: require(4),
      destinationTokenProgram: require(6),
      destinationAccount: optionalDest === JUPITER_PROGRAM ? require(2) : optionalDest,
      ...scalars(8),
    };
  }
  if (startsWith(data, SHARED_ROUTE_V2)) {
    /* u8 id precedes the same scalars — prefix is 8 + 1 + 22 = 31 bytes. */
    if (ix.accountIndices.length < 12 || !planWellFormed(31)) {
      return undefined;
    }
    return {
      authority: require(1),
      sourceMint: require(6),
      destinationMint: require(7),
      destinationTokenProgram: require(9),
      destinationAccount: require(5),
      ...scalars(9),
    };
  }
  return undefined;
};
