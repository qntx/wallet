/**
 * The strict CBOR subset the Keystone driver decodes device answers with. Only the types the UR
 * registry uses — uint, bytes, text, array, map, tag, true and false — and only their canonical
 * form: definite lengths, shortest-form heads, distinct map keys, valid UTF-8 text, bounded depth
 * and breadth, and no trailing bytes. Any deviation — a malformed head, an indefinite container, a
 * non-minimal length, a duplicate key, garbage after the item — throws `KernelError("integrity")`;
 * the decoder never surfaces an untyped error and never loops.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { KernelError } from "../../../errors.ts";

export type Cbor =
  | { readonly kind: "uint"; readonly value: number }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "array"; readonly items: ReadonlyArray<Cbor> }
  | { readonly kind: "map"; readonly entries: ReadonlyArray<readonly [Cbor, Cbor]> }
  | { readonly kind: "tag"; readonly tag: number; readonly item: Cbor }
  | { readonly kind: "bool"; readonly value: boolean };

/** Device answers are QR payloads — the protocol already bounds them; the decoder re-asserts. */
const MAX_BYTES = 262_144;
/** Registry structures are flat: multi-accounts keys, a keypath's components, small maps. */
const MAX_DEPTH = 8;
const MAX_ITEMS = 4096;

function fail(): never {
  throw new KernelError("integrity", "malformed cbor");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

type Cursor = { readonly bytes: Uint8Array; offset: number };

const take = (cursor: Cursor, length: number): Uint8Array => {
  if (length < 0 || cursor.offset + length > cursor.bytes.length) {
    fail();
  }
  const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return slice;
};

/**
 * One argument slot: the embedded value of a head. Only minimal encodings pass — a value that fits
 * a shorter slot is a non-canonical, hand-built deviation (strict-CBOR decoders reject it).
 */
const argument = (cursor: Cursor, info: number): number => {
  let value: number;
  let bytes = 0;
  if (info < 24) {
    return info;
  }
  if (info === 24) {
    bytes = 1;
  } else if (info === 25) {
    bytes = 2;
  } else if (info === 26) {
    bytes = 4;
  } else if (info === 27) {
    bytes = 8;
  } else {
    fail();
  }
  const slot = take(cursor, bytes);
  if (bytes === 8) {
    const wide = new DataView(slot.buffer, slot.byteOffset, 8).getBigUint64(0);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail();
    }
    value = Number(wide);
  } else {
    value = 0;
    for (const byte of slot) {
      value = value * 256 + byte;
    }
  }
  // Shortest form: the value must not fit the next smaller slot.
  const minimum = bytes === 1 ? 24 : bytes === 2 ? 256 : bytes === 4 ? 65536 : 2 ** 32;
  if (value < minimum) {
    fail();
  }
  return value;
};

const length = (cursor: Cursor, info: number): number => {
  // Indefinite containers arrive as info 31 — rejected by argument() before this returns.
  const value = argument(cursor, info);
  if (value > MAX_ITEMS) {
    fail();
  }
  return value;
};

const item = (cursor: Cursor, depth: number): Cbor => {
  if (depth > MAX_DEPTH) {
    fail();
  }
  const head = take(cursor, 1)[0] ?? 0;
  const major = Math.trunc(head / 32);
  const info = head % 32;
  switch (major) {
    case 0:
      return { kind: "uint", value: argument(cursor, info) };
    case 2:
      return { kind: "bytes", value: take(cursor, argument(cursor, info)) };
    case 3: {
      const raw = take(cursor, argument(cursor, info));
      try {
        return { kind: "text", value: utf8.decode(raw) };
      } catch {
        return fail();
      }
    }
    case 4: {
      const count = length(cursor, info);
      const items: Cbor[] = [];
      for (let i = 0; i < count; i++) {
        items.push(item(cursor, depth + 1));
      }
      return { kind: "array", items };
    }
    case 5: {
      const count = length(cursor, info);
      const seen = new Set<string>();
      const entries: Array<[Cbor, Cbor]> = [];
      for (let i = 0; i < count; i++) {
        const key = item(cursor, depth + 1);
        // Canonical re-encoding makes "same key" a byte comparison.
        const encoded = encodeCbor(key).join(",");
        if (seen.has(encoded)) {
          fail();
        }
        seen.add(encoded);
        entries.push([key, item(cursor, depth + 1)]);
      }
      return { kind: "map", entries };
    }
    case 6:
      return { kind: "tag", tag: argument(cursor, info), item: item(cursor, depth + 1) };
    case 7:
      if (info === 20 || info === 21) {
        return { kind: "bool", value: info === 21 };
      }
      return fail();
    default:
      // Major type 1 (negative ints) is outside the registry's subset.
      return fail();
  }
};

/** Parses exactly one canonical item from `bytes` — trailing input is malformed. */
export const decodeCbor = (bytes: Uint8Array): Cbor => {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    fail();
  }
  const cursor: Cursor = { bytes, offset: 0 };
  const parsed = item(cursor, 1);
  if (cursor.offset !== bytes.length) {
    fail();
  }
  return parsed;
};

const head = (major: number, value: number, out: number[]): void => {
  if (value < 24) {
    out.push(major * 32 + value);
  } else if (value < 256) {
    out.push(major * 32 + 24, value);
  } else if (value < 65536) {
    out.push(major * 32 + 25, Math.trunc(value / 256), value % 256);
  } else if (value < 2 ** 32) {
    out.push(
      major * 32 + 26,
      Math.trunc(value / 16777216),
      Math.trunc(value / 65536) % 256,
      Math.trunc(value / 256) % 256,
      value % 256,
    );
  } else {
    out.push(major * 32 + 27);
    let rest = BigInt(value);
    const slot: number[] = [];
    for (let i = 0; i < 8; i++) {
      slot.unshift(Number(rest % 256n));
      rest /= 256n;
    }
    out.push(...slot);
  }
};

/** Serialises the tree canonically — shortest heads, in-order map keys, definite lengths. */
export const encodeCbor = (value: Cbor): Uint8Array => {
  const out: number[] = [];
  const emit = (node: Cbor): void => {
    switch (node.kind) {
      case "uint":
        head(0, node.value, out);
        break;
      case "bytes":
        head(2, node.value.length, out);
        for (const byte of node.value) {
          out.push(byte);
        }
        break;
      case "text": {
        const raw = utf8ToBytes(node.value);
        head(3, raw.length, out);
        for (const byte of raw) {
          out.push(byte);
        }
        break;
      }
      case "array":
        head(4, node.items.length, out);
        for (const entry of node.items) {
          emit(entry);
        }
        break;
      case "map":
        head(5, node.entries.length, out);
        for (const [key, entry] of node.entries) {
          emit(key);
          emit(entry);
        }
        break;
      case "tag":
        head(6, node.tag, out);
        emit(node.item);
        break;
      case "bool":
        out.push(node.value ? 0xf5 : 0xf4);
        break;
    }
  };
  emit(value);
  return new Uint8Array(out);
};
