/**
 * Private byte helpers shared inside protocol/. Label strings are ASCII without a terminator
 * (protocol.md §1); integers on the wire are big-endian u16/u32.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export const ascii: (text: string) => Uint8Array = utf8ToBytes;

export function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** Big-endian u16 at the end of a two-or-more-byte buffer (the status word position). */
export function readSw(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 2, 2).getUint16(0);
}

export function wipe(...buffers: Uint8Array[]): void {
  for (const buffer of buffers) {
    buffer.fill(0);
  }
}

type Secp256k1Point = InstanceType<typeof secp256k1.Point>;

/** A secp256k1 point decoded and curve-checked; `undefined` on any malformed input. */
export function tryPoint(bytes: Uint8Array): Secp256k1Point | undefined {
  try {
    // noble's fromBytes already rejects points that are not on the curve
    return secp256k1.Point.fromBytes(bytes);
  } catch {
    return undefined;
  }
}

/** Whether `bytes` is a valid secp256k1 point encoding (compressed or uncompressed). */
export function validPoint(bytes: Uint8Array): boolean {
  return tryPoint(bytes) !== undefined;
}

/** Whether `bytes` is a valid 65-byte uncompressed secp256k1 point (`0x04 ‖ x ‖ y`). */
export function validUncompressedPoint(bytes: Uint8Array): boolean {
  return bytes.length === 65 && bytes[0] === 0x04 && validPoint(bytes);
}
