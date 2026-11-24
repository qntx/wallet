/**
 * Byte helpers shared inside the Ledger protocol module. Integers on the wire are big-endian unless
 * noted; the Bitcoin varint (scripts/ledger vectors, doc/merkle.md) is the exception.
 */
import type { KeyPath } from "@qntx/wallet-chains";

import { LedgerError } from "./errors.ts";

export const input = (message: string): LedgerError => new LedgerError("invalid-input", message);

const response = (message: string): LedgerError => new LedgerError("invalid-response", message);

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

export function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}

/** Bitcoin CompactSize varint (doc/merkle.md "Merkleized maps" counts keys this way). */
export function varint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw input("varint value is not a non-negative safe integer");
  }
  if (value < 0xfd) {
    return Uint8Array.of(value);
  }
  if (value <= 0xffff) {
    const out = new Uint8Array(3);
    new DataView(out.buffer).setUint8(0, 0xfd);
    new DataView(out.buffer).setUint16(1, value, true);
    return out;
  }
  if (value <= 0xffffffff) {
    const out = new Uint8Array(5);
    new DataView(out.buffer).setUint8(0, 0xfe);
    new DataView(out.buffer).setUint32(1, value, true);
    return out;
  }
  const out = new Uint8Array(9);
  new DataView(out.buffer).setUint8(0, 0xff);
  new DataView(out.buffer).setBigUint64(1, BigInt(value), true);
  return out;
}

/**
 * `depth ‖ u32(index)…` (ledger-app-solana/doc/api.md "BIP32 path encoding"): depth 1..maxDepth,
 * indices are u32 (≥ 0x80000000 hardened), else `invalid-input`.
 */
export function encodePath(path: KeyPath, maxDepth: number): Uint8Array {
  if (path.length === 0 || path.length > maxDepth) {
    throw input("derivation path depth out of range");
  }
  const out = new Uint8Array(1 + 4 * path.length);
  out[0] = path.length;
  const view = new DataView(out.buffer);
  for (const [i, index] of path.entries()) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
      throw input("derivation path index is not a u32");
    }
    view.setUint32(1 + 4 * i, index);
  }
  return out;
}

/**
 * A bounded cursor over a device response: every read checks its span, `end()` requires the buffer
 * consumed. Any overrun or leftover is `invalid-response`.
 */
export class Reader {
  private offset = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  private take(count: number): Uint8Array {
    if (count < 0 || this.remaining < count) {
      throw response("response is shorter than its declared layout");
    }
    const out = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  private view<T>(count: number, read: (view: DataView) => T): T {
    const slice = this.take(count);
    return read(new DataView(slice.buffer, slice.byteOffset, slice.byteLength));
  }

  u8(): number {
    return this.view(1, (v) => v.getUint8(0));
  }

  u16(): number {
    return this.view(2, (v) => v.getUint16(0));
  }

  u32(): number {
    return this.view(4, (v) => v.getUint32(0));
  }

  bytes(count: number): Uint8Array {
    return this.take(count);
  }

  /** U8-length-prefixed bytes. */
  lv(): Uint8Array {
    const length = this.u8();
    return this.take(length);
  }

  /** Bitcoin CompactSize varint; counts beyond u53 are not representable and rejected. */
  varint(): number {
    const tag = this.u8();
    if (tag < 0xfd) {
      return tag;
    }
    if (tag === 0xfd) {
      return this.view(2, (v) => v.getUint16(0, true));
    }
    if (tag === 0xfe) {
      return this.view(4, (v) => v.getUint32(0, true));
    }
    const value = this.view(8, (v) => v.getBigUint64(0, true));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw response("varint count does not fit in a safe integer");
    }
    return Number(value);
  }

  rest(): Uint8Array {
    return this.take(this.remaining);
  }

  end(): void {
    if (this.remaining !== 0) {
      throw response("response has trailing bytes");
    }
  }
}
