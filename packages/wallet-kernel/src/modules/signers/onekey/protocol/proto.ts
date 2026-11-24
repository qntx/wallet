/**
 * A minimal proto2 codec driven by hand-written descriptors: only the scalar and message kinds the
 * firmware schemas use on the wire (varint scalars, length-delimited bytes/string/message).
 * Encoding follows proto2 presence — a field present in the value is written even when it is empty,
 * zero or false — and emits fields in ascending field number, so bytes match the reference runtime
 * (`scripts/vectors/onekey-messages.py` is the oracle). Decoding is strict against untrusted device
 * bytes: every rejection is `device-fault`, every caller input failure is `invalid-input`.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { OneKeyError } from "./errors.ts";

export type Rule = "required" | "optional" | "repeated";

type ScalarKind = "uint32" | "uint64" | "bool" | "enum" | "bytes" | "string";

/** Varint wire type; the length-delimited kinds all share wire type 2. */
const WIRE_VARINT = 0;
const WIRE_LENGTH = 2;

export type FieldSpec =
  | { readonly no: number; readonly kind: ScalarKind; readonly rule: Rule }
  | {
      readonly no: number;
      readonly kind: "message";
      readonly rule: Rule;
      readonly message: MessageDef;
    };

export type Fields = Readonly<Record<string, FieldSpec>>;

export type MessageDef<F extends Fields = Fields> = {
  readonly typeId: number;
  readonly fields: F;
};

type FieldValue<F extends FieldSpec> = F extends { readonly kind: "uint64" }
  ? bigint
  : F extends { readonly kind: "bytes" }
    ? Uint8Array
    : F extends { readonly kind: "string" }
      ? string
      : F extends { readonly kind: "bool" }
        ? boolean
        : F extends { readonly kind: "uint32" | "enum" }
          ? number
          : F extends { readonly kind: "message"; readonly message: infer M }
            ? M extends MessageDef<infer G>
              ? Decoded<G>
              : never
            : never;

export type Decoded<F extends Fields> = {
  [K in keyof F as F[K]["rule"] extends "required" ? K : never]: FieldValue<F[K]>;
} & {
  [K in keyof F as F[K]["rule"] extends "optional" ? K : never]?: FieldValue<F[K]>;
} & {
  [K in keyof F as F[K]["rule"] extends "repeated" ? K : never]?: ReadonlyArray<FieldValue<F[K]>>;
};

/** Field numbers are positive integers below 2^29 (proto tag space). */
const MAX_FIELD_NUMBER = 0x1f_ff_ff_ff;
const UINT32_MAX = 0xff_ff_ff_ff;
const UINT64_MAX = 2n ** 64n - 1n;
const MAX_DEPTH = 8;

export function defineMessage<const F extends Fields>(typeId: number, fields: F): MessageDef<F> {
  for (const [name, spec] of Object.entries(fields)) {
    if (!Number.isInteger(spec.no) || spec.no < 1 || spec.no > MAX_FIELD_NUMBER) {
      throw new OneKeyError("invalid-input", `bad field number for ${name}`);
    }
  }
  if (!Number.isInteger(typeId) || typeId < 0 || typeId > 0xffff) {
    throw new OneKeyError("invalid-input", "bad message type id");
  }
  return { typeId, fields };
}

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);

function invalid(message: string): OneKeyError {
  return new OneKeyError("invalid-input", message);
}

function varintBytes(value: bigint, into: number[]): void {
  let v = value;
  do {
    const byte = Number(v % 128n);
    v /= 128n;
    into.push(v === 0n ? byte : byte + 0x80);
  } while (v !== 0n);
}

/** Reads a varint at `pos`; rejects truncation, > 10 bytes, and values ≥ 2^64. */
function readVarint(data: Uint8Array, pos: number): readonly [bigint, number] {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    const at = pos + i;
    if (at >= data.length) {
      throw fault("truncated varint");
    }
    const byte = data[at] ?? 0;
    value += BigInt(byte % 128) * 128n ** BigInt(i);
    if (byte < 0x80) {
      if (i === 9 && byte > 1) {
        throw fault("varint exceeds 64 bits");
      }
      return [value, at + 1];
    }
  }
  throw fault("varint longer than 10 bytes");
}

function wireOf(spec: FieldSpec): number {
  switch (spec.kind) {
    case "bytes":
    case "string":
    case "message":
      return WIRE_LENGTH;
    default:
      return WIRE_VARINT;
  }
}

type Scalar = number | bigint | boolean;

function scalarFromVarint(kind: ScalarKind, value: bigint): Scalar {
  switch (kind) {
    case "uint32":
    case "enum":
      if (value > BigInt(UINT32_MAX)) {
        throw fault("uint32 field overflows");
      }
      return Number(value);
    case "uint64":
      return value;
    case "bool":
      if (value !== 0n && value !== 1n) {
        throw fault("bool field is not 0 or 1");
      }
      return value === 1n;
    default:
      throw fault("length-delimited field on a varint path");
  }
}

function skipField(data: Uint8Array, pos: number, wire: number): number {
  switch (wire) {
    case WIRE_VARINT:
      return readVarint(data, pos)[1];
    case 1:
      if (pos + 8 > data.length) {
        throw fault("truncated fixed64");
      }
      return pos + 8;
    case WIRE_LENGTH: {
      const [length, start] = readVarint(data, pos);
      if (length > BigInt(data.length - start)) {
        throw fault("length past the end of the message");
      }
      return start + Number(length);
    }
    case 5:
      if (pos + 4 > data.length) {
        throw fault("truncated fixed32");
      }
      return pos + 4;
    default:
      throw fault(`unsupported wire type ${wire}`);
  }
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function readLengthDelimited(
  spec: FieldSpec,
  data: Uint8Array,
  pos: number,
  depth: number,
): readonly [unknown, number] {
  const [length, start] = readVarint(data, pos);
  if (length > BigInt(data.length - start)) {
    throw fault("length past the end of the message");
  }
  const end = start + Number(length);
  const body = data.subarray(start, end);
  switch (spec.kind) {
    case "bytes":
      return [new Uint8Array(body), end];
    case "string":
      try {
        return [textDecoder.decode(body), end];
      } catch {
        throw fault("invalid UTF-8 in a string field");
      }
    case "message":
      return [decodeAt(spec.message, body, depth + 1), end];
    default:
      throw fault("varint field on a length-delimited path");
  }
}

function mergeField(
  out: Record<string, unknown>,
  name: string,
  spec: FieldSpec,
  items: ReadonlyArray<unknown>,
): void {
  if (spec.rule === "repeated") {
    const existing = out[name];
    out[name] = isArray(existing) ? [...existing, ...items] : items;
    return;
  }
  const [single] = items;
  out[name] = single;
}

const isArray = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

function decodeAt<F extends Fields>(
  def: MessageDef<F>,
  data: Uint8Array,
  depth: number,
): Decoded<F> {
  if (depth > MAX_DEPTH) {
    throw fault("message nested deeper than 8 levels");
  }
  const byNumber = new Map<number, { name: string; spec: FieldSpec }>();
  for (const [name, spec] of Object.entries(def.fields)) {
    byNumber.set(spec.no, { name, spec });
  }
  const out: Record<string, unknown> = {};
  const seen = new Set<number>();
  let pos = 0;
  while (pos < data.length) {
    const [key, afterKey] = readVarint(data, pos);
    pos = afterKey;
    const number = Number(key / 8n);
    const wire = Number(key % 8n);
    if (number === 0) {
      throw fault("field number 0");
    }
    // Wire types 3/4/6/7 need no early rejection: unknown ones fail in skipField, known ones in
    // the wire-mismatch check below.
    const known = byNumber.get(number);
    if (known === undefined) {
      pos = skipField(data, pos, wire);
      continue;
    }
    const { name, spec } = known;
    const repeated = spec.rule === "repeated";
    if (!repeated && seen.has(spec.no)) {
      throw fault("non-repeated field appears twice");
    }
    const lengthDelimited =
      spec.kind === "bytes" || spec.kind === "string" || spec.kind === "message";
    const expectedWire = lengthDelimited ? WIRE_LENGTH : WIRE_VARINT;
    if (wire !== expectedWire && !(repeated && !lengthDelimited && wire === WIRE_LENGTH)) {
      throw fault("wire type mismatch for a known field");
    }
    if (lengthDelimited) {
      const [value, next] = readLengthDelimited(spec, data, pos, depth);
      pos = next;
      mergeField(out, name, spec, [value]);
    } else if (wire === WIRE_LENGTH) {
      // Packed repeated scalars: a counted run of bare varints.
      const [length, start] = readVarint(data, pos);
      if (length > BigInt(data.length - start)) {
        throw fault("length past the end of the message");
      }
      const end = start + Number(length);
      // The run is sliced out so a varint whose continuation bit crosses `end` is a truncated
      // varint, not a silent read into the next field.
      const packed = data.subarray(start, end);
      const items: Scalar[] = [];
      let packedPos = 0;
      while (packedPos < packed.length) {
        const [value, next] = readVarint(packed, packedPos);
        packedPos = next;
        items.push(scalarFromVarint(spec.kind, value));
      }
      mergeField(out, name, spec, items);
      pos = end;
    } else {
      const [value, next] = readVarint(data, pos);
      pos = next;
      mergeField(out, name, spec, [scalarFromVarint(spec.kind, value)]);
    }
    seen.add(spec.no);
  }
  for (const [name, spec] of Object.entries(def.fields)) {
    if (spec.rule === "required" && out[name] === undefined) {
      throw fault("missing required field");
    }
  }
  // `out` holds exactly the descriptor-decoded values; TS cannot prove the mapped-type
  // correspondence.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return out as Decoded<F>;
}

export function decode<F extends Fields>(def: MessageDef<F>, data: Uint8Array): Decoded<F> {
  return decodeAt(def, data, 1);
}

function checkScalar(kind: ScalarKind, value: unknown): bigint {
  switch (kind) {
    case "uint32":
    case "enum":
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > UINT32_MAX
      ) {
        throw invalid("uint32/enum field must be an integer in [0, 2^32)");
      }
      return BigInt(value);
    case "uint64":
      if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
        throw invalid("uint64 field must be a bigint in [0, 2^64)");
      }
      return value;
    case "bool":
      if (typeof value !== "boolean") {
        throw invalid("bool field must be a boolean");
      }
      return value ? 1n : 0n;
    default:
      throw invalid("length-delimited field on a varint path");
  }
}

function encodeField(spec: FieldSpec, value: unknown, into: number[], depth: number): void {
  switch (spec.kind) {
    case "bytes":
      if (!(value instanceof Uint8Array)) {
        throw invalid("bytes field must be a Uint8Array");
      }
      varintBytes(BigInt(value.length), into);
      for (const byte of value) {
        into.push(byte);
      }
      return;
    case "string":
      if (typeof value !== "string") {
        throw invalid("string field must be a string");
      }
      {
        const bytes = utf8ToBytes(value);
        varintBytes(BigInt(bytes.length), into);
        for (const byte of bytes) {
          into.push(byte);
        }
      }
      return;
    case "message": {
      if (typeof value !== "object" || value === null || isArray(value)) {
        throw invalid("message field must be an object");
      }
      // A `message` field's runtime value is the nested message's decoded shape, verified as an
      // object above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const nested = encodeAt(spec.message, value as Readonly<Record<string, unknown>>, depth + 1);
      varintBytes(BigInt(nested.length), into);
      for (const byte of nested) {
        into.push(byte);
      }
      return;
    }
    default:
      varintBytes(checkScalar(spec.kind, value), into);
  }
}

function encodeAt(
  def: MessageDef,
  record: Readonly<Record<string, unknown>>,
  depth: number,
): Uint8Array {
  if (depth > MAX_DEPTH) {
    throw invalid("message nested deeper than 8 levels");
  }
  const specs = Object.entries(def.fields)
    .map(([name, spec]) => ({ name, spec }))
    .sort((a, b) => a.spec.no - b.spec.no);
  const out: number[] = [];
  for (const { name, spec } of specs) {
    const field = record[name];
    if (field === undefined) {
      if (spec.rule === "required") {
        throw invalid(`missing required field ${name}`);
      }
      continue;
    }
    if (spec.rule === "repeated") {
      if (!isArray(field)) {
        throw invalid(`repeated field ${name} must be an array`);
      }
      for (const item of field) {
        varintBytes(BigInt(spec.no) * 8n + BigInt(wireOf(spec)), out);
        encodeField(spec, item, out, depth);
      }
    } else {
      varintBytes(BigInt(spec.no) * 8n + BigInt(wireOf(spec)), out);
      encodeField(spec, field, out, depth);
    }
  }
  return Uint8Array.from(out);
}

export function encode<F extends Fields>(def: MessageDef<F>, value: Decoded<F>): Uint8Array {
  // A decoded value is a plain record keyed by the descriptor's TS names; each field's shape is
  // checked in encodeField below, so handing it to the untyped inner path is safe.
  return encodeAt(def, value, 1);
}
