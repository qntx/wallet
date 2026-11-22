/**
 * The §1 `KDF` (NIST SP 800-56C Rev. 2 §4.1 one-step, option 1, H = SHA-256) and the ISO/IEC 9797-1
 * padding method 2 used by the record layer. `KDF108` is card-side only and deliberately absent.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";

import { u32 } from "./bytes.ts";
import { CardError } from "./errors.ts";

/** `KDF(Z, label, ctx, len)` = first `len` bytes of `SHA-256(u32(i) ‖ Z ‖ label ‖ ctx)`, `len ≤ 64`. */
export function kdf(z: Uint8Array, label: Uint8Array, ctx: Uint8Array, len: number): Uint8Array {
  if (len < 1 || len > 64) {
    throw new CardError("invalid-input", "KDF output length outside 1..64");
  }
  const fixedInfo = concatBytes(label, ctx);
  const out = new Uint8Array(len <= 32 ? 32 : 64);
  out.set(sha256(concatBytes(u32(1), z, fixedInfo)), 0);
  if (len > 32) {
    out.set(sha256(concatBytes(u32(2), z, fixedInfo)), 32);
  }
  return new Uint8Array(out.subarray(0, len));
}

/** `M2(X)` = `X ‖ 0x80 ‖ 0ᵏ` with the smallest `k ≥ 0` making the length a multiple of 16. */
export function m2(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(data.length + 1 + ((16 - ((data.length + 1) % 16)) % 16));
  padded.set(data);
  padded[data.length] = 0x80;
  return padded;
}

/**
 * `unM2(Y)` — `undefined` when `Y` is empty, not a multiple of 16, when the last non-zero byte is
 * not `0x80`, or when more than 15 zero bytes follow it (protocol.md §1).
 */
export function unM2(padded: Uint8Array): Uint8Array | undefined {
  if (padded.length === 0 || padded.length % 16 !== 0) {
    return undefined;
  }
  let marker = padded.length - 1;
  while (marker >= 0 && padded[marker] === 0) {
    marker -= 1;
  }
  if (marker < 0 || padded[marker] !== 0x80 || padded.length - 1 - marker > 15) {
    return undefined;
  }
  return padded.subarray(0, marker);
}
