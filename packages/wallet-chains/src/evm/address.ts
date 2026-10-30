import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as Address from "ox/Address";

import { ChainError } from "../index.ts";

/** EIP-55 checksummed address, e.g. `0x52908400098527886E0F7030069857D2E4169EE7`. */
export const isEvmAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

export function checksumEvmAddress(address: string): string {
  if (!isEvmAddress(address)) {
    throw new ChainError("invalid-address", "not an EVM address");
  }
  const checksummed = Address.checksum(address);
  Address.assert(checksummed, { strict: true });
  return checksummed;
}

/** `keccak256(pubkey)[12:]` — accepts a 33-byte compressed or 65-byte uncompressed secp256k1 key. */
export function evmAddressFromPublicKey(pubkey: Uint8Array): string {
  const uncompressed =
    pubkey.length === 65 && pubkey[0] === 4
      ? pubkey
      : pubkey.length === 33
        ? secp256k1.Point.fromBytes(pubkey).toBytes(false)
        : undefined;
  if (uncompressed === undefined || uncompressed[0] !== 4) {
    throw new ChainError("invalid-address", "expected a compressed or uncompressed secp256k1 key");
  }
  return checksumEvmAddress(`0x${bytesToHex(keccak_256(uncompressed.subarray(1))).slice(-40)}`);
}
