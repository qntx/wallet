/** Well-known Solana program ids (base58, 32 bytes) — frozen constants. */
export const PROGRAM_IDS: Readonly<{
  system: string;
  computeBudget: string;
  associatedToken: string;
  token: string;
  token2022: string;
  stake: string;
}> = Object.freeze({
  system: "11111111111111111111111111111111",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  stake: "Stake11111111111111111111111111111111111111",
});

/**
 * CAIP-2 ids the wallet knows. The wire message itself carries no network marker — `network` is the
 * only declaration and cannot be proven from the bytes.
 */
export const SOLANA_NETWORKS: ReadonlyArray<string> = Object.freeze([
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
] as const);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isSolanaAddress = (value: string): boolean => BASE58.test(value);

import { getAddressDecoder } from "@solana/addresses";

import { ChainError } from "../index.ts";

const decoder = getAddressDecoder();

/** Base58-encoded address for a 32-byte ed25519 public key. */
export function solanaAddressFromPublicKey(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) {
    throw new ChainError("invalid-address", "expected a 32-byte ed25519 public key");
  }
  return decoder.decode(pubkey);
}
