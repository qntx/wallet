/**
 * Secret encodings as wipeable ASCII bytes. Library encoders (`bytesToHex`, `base58.encode`) return
 * JS strings, which can never be zeroed — a private key encoded for export would linger in the
 * heap. These write the same bytes the caller can `wipe` after the wire message is built.
 */

import { utf8ToBytes } from "@noble/hashes/utils.js";

const hexChar = (nibble: number): number => (nibble < 10 ? 0x30 + nibble : 0x61 + (nibble - 10)); // "0".."9", "a".."f"

/** ASCII bytes of `0x` + lowercase hex — the EVM private-key encoding. */
export function encodeHexAscii(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + bytes.length * 2);
  out[0] = 0x30; // "0"
  out[1] = 0x78; // "x"
  for (const [i, b] of bytes.entries()) {
    out[2 + i * 2] = hexChar(Math.floor(b / 16));
    out[3 + i * 2] = hexChar(b % 16);
  }
  return out;
}

/** "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz" as bytes. */
const BASE58_ALPHABET = utf8ToBytes("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");

/** ASCII bytes of the Bitcoin-alphabet base58 encoding — the Solana private-key encoding. */
export function encodeBase58Ascii(bytes: Uint8Array): Uint8Array {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }
  // The carry/divide bignum lives in scratch — secret-derived intermediate state that must be
  // wiped, so no growing number[] and no string. Each input byte adds under 1.37 digits.
  const scratch = new Uint8Array((bytes.length - zeros) * 2 + 1);
  try {
    let length = 0;
    for (let i = zeros; i < bytes.length; i++) {
      let carry = bytes[i] ?? 0;
      let j = 0;
      while (carry > 0 || j < length) {
        carry += (scratch[j] ?? 0) * 256;
        scratch[j] = carry % 58;
        carry = Math.floor(carry / 58);
        j += 1;
      }
      length = j;
    }
    const out = new Uint8Array(zeros + length);
    out.fill(0x31, 0, zeros); // each leading zero byte encodes as "1"
    for (let i = 0; i < length; i++) {
      // Digits accumulate little-endian; the encoding reads most-significant first.
      out[zeros + i] = BASE58_ALPHABET[scratch[length - 1 - i] ?? 0] ?? 0x31;
    }
    return out;
  } finally {
    scratch.fill(0);
  }
}
