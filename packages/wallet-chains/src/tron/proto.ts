/**
 * A strict protobuf wire reader/writer for the TRON protocol messages. Unlike the google-protobuf
 * and `@bufbuild/protobuf` readers — which accept non-minimal varints, out-of-order and duplicated
 * fields — this reader enforces the canonical encoding a transaction must have: varints are minimal
 * and fit uint64, field numbers are strictly ascending (a declared repeated field may repeat
 * consecutively), and every accepted input re-encodes to itself. Every malformed input throws
 * `ChainError("invalid-request", …)` — never another error type and never a loop.
 */
// oxlint-disable eslint/no-bitwise -- varints and wire tags are decoded bit by bit

import { ChainError } from "../index.ts";

/** Every malformed protobuf input is an invalid-request with a specific reason. */
export function malformed(what: string): never {
  throw new ChainError("invalid-request", `malformed protobuf: ${what}`);
}

/**
 * A canonical varint: at most 10 bytes, the 10th byte carrying only bit 63 (`< 2^64`), and minimal
 * — a multi-byte varint's last byte is non-zero, so `0x80 0x00` and friends are rejected.
 */
export const readVarint = (
  bytes: Uint8Array,
  offset: number,
): { readonly value: bigint; readonly next: number } => {
  let value = 0n;
  for (let i = 0; ; i++) {
    if (i === 10) {
      malformed("varint longer than 10 bytes");
    }
    const at = offset + i;
    const b = bytes[at];
    if (b === undefined) {
      malformed("truncated varint");
    }
    if ((b & 0x80) === 0) {
      if (i > 0 && b === 0) {
        malformed("non-minimal varint");
      }
      if (i === 9 && b > 1) {
        malformed("varint exceeds 64 bits");
      }
      value |= BigInt(b) << BigInt(i * 7);
      return { value, next: at + 1 };
    }
    value |= BigInt(b & 0x7f) << BigInt(i * 7);
  }
};

export const writeVarint = (value: bigint): Uint8Array => {
  const out: number[] = [];
  let v = value;
  for (;;) {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) {
      b |= 0x80;
    }
    out.push(b);
    if (v === 0n) {
      return Uint8Array.from(out);
    }
  }
};

/** One decoded field: its wire type, the value form for wires 0/2, and the verbatim raw slice. */
export type ProtoField = {
  readonly field: number;
  readonly wire: 0 | 1 | 2 | 5;
  /** The whole encoded field, tag included — what the writer re-emits for unknown fields. */
  readonly bytes: Uint8Array;
  /** Wire 0. */
  readonly varint: bigint | undefined;
  /** Wire 2 payload. */
  readonly data: Uint8Array | undefined;
};

const isWire = (wire: number): wire is 0 | 1 | 2 | 5 =>
  wire === 0 || wire === 1 || wire === 2 || wire === 5;

/**
 * Iterates a message's fields in encoding order, enforcing the canonical layout: wire types are
 * varint (0), length-delimited (2) or fixed 32/64 (5, 1 — kept only to capture unknown fields);
 * groups (3/4) and the reserved types (6/7) are malformed. Field numbers ascend strictly; a field
 * may repeat only when `repeated` declares it, and only consecutively.
 */
export const readFields = (
  bytes: Uint8Array,
  repeated: ReadonlyArray<number> = [],
): ReadonlyArray<ProtoField> => {
  const fields: ProtoField[] = [];
  let last = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    const tag = readVarint(bytes, offset);
    offset = tag.next;
    const wire = Number(tag.value & 7n);
    const field = Number(tag.value >> 3n);
    if (field === 0) {
      malformed("field number 0");
    }
    if (!isWire(wire)) {
      malformed(`unsupported wire type ${wire} of field ${field}`);
    }
    if (field < last) {
      malformed(`field ${field} follows field ${last}`);
    }
    if (field === last && !repeated.includes(field)) {
      malformed(`field ${field} is not repeated`);
    }
    last = field;
    let varint: bigint | undefined;
    let data: Uint8Array | undefined;
    if (wire === 0) {
      const v = readVarint(bytes, offset);
      varint = v.value;
      offset = v.next;
    } else if (wire === 2) {
      const len = readVarint(bytes, offset);
      offset = len.next;
      if (len.value > BigInt(bytes.length - offset)) {
        malformed(`field ${field} length exceeds the message`);
      }
      data = bytes.subarray(offset, offset + Number(len.value));
      offset += Number(len.value);
    } else {
      const size = wire === 1 ? 8 : 4;
      if (bytes.length - offset < size) {
        malformed(`field ${field} is truncated`);
      }
      data = bytes.subarray(offset, offset + size);
      offset += size;
    }
    fields.push({ field, wire, bytes: bytes.subarray(start, offset), varint, data });
  }
  return fields;
};

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const tag = (field: number, wire: number): Uint8Array => writeVarint(BigInt(field * 8 + wire));

/**
 * One encoded field, or undefined when its value is a proto3 default (0, false, empty bytes or
 * string) and canonical encoding omits it entirely.
 */
export const varintField = (field: number, value: bigint | number): Uint8Array | undefined =>
  BigInt(value) === 0n ? undefined : concat([tag(field, 0), writeVarint(BigInt(value))]);

/** A varint field that is emitted even when 0 — required presence, e.g. `lock = false`. */
export const requiredVarintField = (field: number, value: bigint | number): Uint8Array =>
  concat([tag(field, 0), writeVarint(BigInt(value))]);

export const bytesField = (field: number, data: Uint8Array): Uint8Array | undefined =>
  data.length === 0 ? undefined : requiredBytesField(field, data);

export const requiredBytesField = (field: number, data: Uint8Array): Uint8Array =>
  concat([tag(field, 2), writeVarint(BigInt(data.length)), data]);

export const stringField = (field: number, value: string): Uint8Array | undefined =>
  value === "" ? undefined : requiredBytesField(field, new TextEncoder().encode(value));

/**
 * Emits a message from encoded field slices: the modeled fields in schema order plus any captured
 * unknown fields (`extra` slices, tag included), all merged by field number. Two slices of the same
 * field keep their relative order (consecutive repeats).
 */
export const encodeMessage = (
  fields: ReadonlyArray<{ readonly field: number; readonly bytes: Uint8Array | undefined }>,
): Uint8Array => {
  const present = fields.filter(
    (f): f is { readonly field: number; readonly bytes: Uint8Array } => f.bytes !== undefined,
  );
  present.sort((a, b) => a.field - b.field);
  return concat(present.map((f) => f.bytes));
};

/** Captured unknown fields, carried verbatim for re-emission and blind-sign detection. */
export type ProtoExtra = ReadonlyArray<ProtoField>;

/**
 * Split a read field list into the decoder's own consumption plus captured unknowns: fields not in
 * `known` are kept verbatim. Callers pass the schema's field numbers; repeated handling was already
 * validated by `readFields`.
 */
export const collectExtra = (
  fields: ReadonlyArray<ProtoField>,
  known: ReadonlyArray<number>,
): ProtoExtra => fields.filter((f) => !known.includes(f.field));

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
