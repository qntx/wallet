import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { createBase58check } from "@scure/base";

import { checksumEvmAddress } from "../evm/address.ts";
import { ChainError } from "../index.ts";

/** The version byte every TRON address (mainnet and testnets alike) carries. */
export const TRON_ADDRESS_PREFIX = 0x41;

const base58check = createBase58check(sha256);

/** A 34-character base58check string whose payload is 21 bytes starting with 0x41. */
export const isTronAddress = (value: string): boolean => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{34}$/.test(value)) {
    return false;
  }
  try {
    const decoded = base58check.decode(value);
    return decoded.length === 21 && decoded[0] === TRON_ADDRESS_PREFIX;
  } catch {
    return false;
  }
};

const tronBytes = (address: string, what: string): Uint8Array => {
  if (!isTronAddress(address)) {
    throw new ChainError("invalid-address", `not a TRON address: ${what}`);
  }
  return base58check.decode(address);
};

/** The 21 raw bytes — 0x41 version byte plus the 20-byte address body. */
export function tronAddressToBytes(address: string): Uint8Array {
  return tronBytes(address, "base58check");
}

/** Base58check encodes a 21-byte payload whose first byte is 0x41. */
export function tronAddressFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 21 || bytes[0] !== TRON_ADDRESS_PREFIX) {
    throw new ChainError("invalid-address", "a TRON address is 21 bytes starting with 0x41");
  }
  return base58check.encode(bytes);
}

/** `"41"` plus the 20-byte body as 40 lowercase hex — the form contract fields carry. */
export function tronAddressToHex(address: string): string {
  return bytesToHex(tronBytes(address, "base58check"));
}

/** `"41"` plus 40 hex — the form `raw_data` contract fields and trongrid JSON carry. */
export function tronAddressFromHex(hex: string): string {
  if (!/^41[0-9a-fA-F]{40}$/.test(hex)) {
    throw new ChainError("invalid-address", "a TRON hex address is 41 plus 40 hex");
  }
  return tronAddressFromBytes(hexToBytes(hex));
}

const is0xPrefixed = (value: string): value is `0x${string}` => value.startsWith("0x");

/** The 20-byte body rendered as an EIP-55 checksummed 0x address (ABI/EVM tooling form). */
export function tronAddressToEvm(address: string): `0x${string}` {
  const checksummed = checksumEvmAddress(`0x${tronAddressToHex(address).slice(2)}`);
  if (!is0xPrefixed(checksummed)) {
    throw new ChainError("invalid-address", "EIP-55 checksum did not produce a 0x address");
  }
  return checksummed;
}

/** 0x plus 40 hex — an EVM-style encoding of the 20-byte body. */
export function tronAddressFromEvm(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new ChainError("invalid-address", "expected a 0x-prefixed 20-byte address");
  }
  return tronAddressFromHex(`41${address.slice(2)}`);
}

/**
 * `0x41 ‖ keccak256(uncompressed[1..])[12..32]` — accepts a 33-byte compressed or 65-byte
 * uncompressed secp256k1 key.
 */
export function tronAddressFromPublicKey(pubkey: Uint8Array): string {
  const uncompressed =
    pubkey.length === 65 && pubkey[0] === 4
      ? pubkey
      : pubkey.length === 33
        ? secp256k1.Point.fromBytes(pubkey).toBytes(false)
        : undefined;
  if (uncompressed === undefined || uncompressed[0] !== 4) {
    throw new ChainError("invalid-address", "expected a compressed or uncompressed secp256k1 key");
  }
  return tronAddressFromBytes(
    concatBytes(
      Uint8Array.of(TRON_ADDRESS_PREFIX),
      keccak_256(uncompressed.subarray(1)).subarray(12),
    ),
  );
}
