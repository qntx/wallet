/**
 * Minimal MessagePack writer — only what the Hyperliquid L1 action hash needs: ints in the smallest
 * form, UTF-8 strings, booleans, arrays, and maps whose entries arrive already ordered (map key
 * order is semantic — it changes the phantom-agent connectionId).
 *
 * Byte-for-byte compatible with the encoder nktkas uses
 * (https://raw.githubusercontent.com/denoland/std/main/msgpack/encode.ts) and with python
 * `msgpack.packb` defaults: positive fixint/uint8/16/32/64, negative fixint/int8/16/32/64,
 * fixstr/str8/16/32, fixarray/array16, fixmap/map16. Numbers ≥ 2^32 or < −2^31 go through BigInt
 * exactly like @std/msgpack's integer path.
 *
 * `@std/msgpack` is deliberately not a dependency: it is a JSR package outside the workspace, and
 * its `encode` iterates an object's own keys — the hash would then follow the host's JSON key
 * order, exactly what must not happen.
 */
import { KernelError } from "../../errors.ts";

const utf8 = new TextEncoder();

export function concat(...chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const u16be = (value: number): Uint8Array => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
};

const u32be = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

const i64be = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value);
  return out;
};

const u64be = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
};

/** Safe integers only — the L1 schemas bound every numeric field well inside them. */
export function packInt(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) {
    throw new KernelError("integrity", "unreachable: non-integer msgpack field");
  }
  if (value >= 0) {
    if (value <= 0x7f) {
      return new Uint8Array([value]);
    }
    if (value <= 0xff) {
      return new Uint8Array([0xcc, value]);
    }
    if (value <= 0xffff) {
      return concat(new Uint8Array([0xcd]), u16be(value));
    }
    if (value <= 0xffffffff) {
      return concat(new Uint8Array([0xce]), u32be(value));
    }
    return concat(new Uint8Array([0xcf]), u64be(BigInt(value)));
  }
  if (value >= -32) {
    return new Uint8Array([value + 256]); // negative fixint 0xe0–0xff
  }
  if (value >= -128) {
    return new Uint8Array([0xd0, value + 256]);
  }
  if (value >= -32768) {
    return concat(new Uint8Array([0xd1]), u16be(value + 65536));
  }
  if (value >= -2147483648) {
    return concat(new Uint8Array([0xd2]), u32be(value + 4294967296));
  }
  return concat(new Uint8Array([0xd3]), i64be(BigInt(value)));
}

export function packStr(value: string): Uint8Array {
  const bytes = utf8.encode(value);
  const { length } = bytes;
  if (length < 32) {
    // oxlint-disable-next-line eslint/no-bitwise -- fixstr packs the length into the low 5 bits
    return concat(new Uint8Array([0xa0 | length]), bytes);
  }
  if (length < 256) {
    return concat(new Uint8Array([0xd9, length]), bytes);
  }
  if (length < 65536) {
    return concat(new Uint8Array([0xda]), u16be(length), bytes);
  }
  return concat(new Uint8Array([0xdb]), u32be(length), bytes);
}

export function packBool(value: boolean): Uint8Array {
  return new Uint8Array([value ? 0xc3 : 0xc2]);
}

export function packArray(items: ReadonlyArray<Uint8Array>): Uint8Array {
  const head =
    items.length < 16
      ? // oxlint-disable-next-line eslint/no-bitwise -- fixarray packs the count into the low 4 bits
        new Uint8Array([0x90 | items.length])
      : items.length < 65536
        ? concat(new Uint8Array([0xdc]), u16be(items.length))
        : (() => {
            throw new KernelError("integrity", "unreachable: msgpack array over 65535 items");
          })();
  return concat(head, ...items);
}

/**
 * Entries arrive already in encoding order — the caller spells the schema's key order out
 * literally; this writer never iterates an object.
 */
export function packMap(entries: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const head =
    entries.length < 16
      ? // oxlint-disable-next-line eslint/no-bitwise -- fixmap packs the count into the low 4 bits
        new Uint8Array([0x80 | entries.length])
      : entries.length < 65536
        ? concat(new Uint8Array([0xde]), u16be(entries.length))
        : (() => {
            throw new KernelError("integrity", "unreachable: msgpack map over 65535 entries");
          })();
  return concat(head, ...entries.flatMap(([key, value]) => [packStr(key), value]));
}
