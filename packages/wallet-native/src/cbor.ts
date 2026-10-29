/**
 * CBOR framing for the kernel channel. `ProtocolValue` travels main-side ↔ kernel-side as CBOR; the
 * C++ layer moves bytes only. Decode is deliberately strict: floats, unsafe integers, undefined,
 * tags, non-string map keys, duplicate keys and indefinite-length items are all rejected — the wire
 * format carries exactly one value domain.
 */
import { decode, encode } from "cborg";
import type { DecodeOptions } from "cborg";

import type { ProtocolValue } from "@qntx/wallet/protocol";

export const FRAME_MAX_BYTES: number = 1024 * 1024;

export type CborErrorCode =
  | "oversize"
  | "truncated"
  | "malformed"
  | "float"
  | "unsafe-int"
  | "bigint"
  | "undefined"
  | "tag"
  | "non-string-key"
  | "duplicate-key"
  | "indefinite"
  | "bad-type";

export class CborError extends Error {
  readonly code: CborErrorCode;
  constructor(code: CborErrorCode, message: string) {
    super(message);
    this.name = "CborError";
    this.code = code;
  }
}

const DECODE_OPTIONS: DecodeOptions = {
  strict: true,
  useMaps: false,
  rejectDuplicateMapKeys: true,
  allowUndefined: false,
  allowIndefinite: false,
  allowNaN: false,
  allowInfinity: false,
  allowBigInt: false,
};

/** Reject non-safe-integer numbers and non-string map keys; cborg flags cover the rest. */
function validate(value: unknown): asserts value is ProtocolValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new CborError("float", "cbor frame: non-integer number");
    }
    if (!Number.isSafeInteger(value)) {
      throw new CborError("unsafe-int", "cbor frame: integer outside the safe range");
    }
    return;
  }
  if (value instanceof Uint8Array) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      validate(item);
    }
    return;
  }
  if (typeof value === "object") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the object came from a CBOR map
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof key !== "string") {
        throw new CborError("non-string-key", "cbor frame: non-string map key");
      }
      validate(item);
    }
    return;
  }
  throw new CborError("bad-type", `cbor frame: unsupported value type ${typeof value}`);
}

/** Classify a cborg rejection into the frame error taxonomy. */
function classify(error: unknown): CborError {
  if (error instanceof CborError) {
    return error;
  }
  const text = error instanceof Error ? error.message : String(error);
  const table: ReadonlyArray<[RegExp, CborErrorCode]> = [
    [/duplicate key|repeat map key/i, "duplicate-key"],
    [/indefinite/i, "indefinite"],
    [/undefined/i, "undefined"],
    [/bigint|safe integer range/i, "unsafe-int"],
    [/tag/i, "tag"],
    [/string/i, "non-string-key"],
  ];
  for (const [pattern, code] of table) {
    if (pattern.test(text)) {
      return new CborError(code, `cbor frame: ${text}`);
    }
  }
  return new CborError("malformed", `cbor frame: ${text}`);
}

/** Encode a `ProtocolValue` to a CBOR frame, enforcing the 1 MiB cap. */
export function encodeFrame(value: ProtocolValue): ArrayBuffer {
  validate(value);
  const bytes = encode(value);
  if (bytes.byteLength > FRAME_MAX_BYTES) {
    throw new CborError("oversize", `cbor frame: ${bytes.byteLength} bytes exceeds the 1 MiB cap`);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Decode a CBOR frame back to a `ProtocolValue`, enforcing the 1 MiB cap and strictness. */
export function decodeFrame(frame: ArrayBuffer | Uint8Array): ProtocolValue {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength > FRAME_MAX_BYTES) {
    throw new CborError("oversize", `cbor frame: ${bytes.byteLength} bytes exceeds the 1 MiB cap`);
  }
  if (bytes.byteLength === 0) {
    throw new CborError("truncated", "cbor frame: empty frame");
  }
  try {
    const value: unknown = decode(bytes, DECODE_OPTIONS);
    validate(value);
    return value;
  } catch (error) {
    throw classify(error);
  }
}
