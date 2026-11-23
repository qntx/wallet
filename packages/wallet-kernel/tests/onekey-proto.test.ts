/**
 * Codec conformance against vectors/onekey/messages.json — bytes produced by Google's protobuf
 * runtime over the firmware schemas (the independent oracle), plus hand-written hostile inputs for
 * every decode rejection the codec guarantees.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import {
  BixinPinInputOnDevice,
  ButtonAck,
  ButtonRequest,
  Failure,
  Features,
  Initialize,
  PassphraseAck,
  PassphraseRequest,
  PinMatrixRequest,
} from "../src/modules/onekey/protocol/messages.ts";
import { decode, defineMessage, encode } from "../src/modules/onekey/protocol/proto.ts";
import type { FieldSpec, Fields, MessageDef } from "../src/modules/onekey/protocol/proto.ts";
import { loadVectors } from "./helpers.ts";
import { Success } from "./onekey-emulator/index.ts";

/**
 * Test-only superset of Features covering the fields the oracle vector sets but the client
 * descriptor omits (revision 13, onekey_ble_name 614 — messages-management.proto, both schemas), so
 * encode() can be checked byte for byte against the oracle.
 */
const FeaturesOracle = defineMessage(17, {
  ...Features.fields,
  revision: { no: 13, kind: "bytes", rule: "optional" },
  onekeyBleName: { no: 614, kind: "string", rule: "optional" },
});

const hex = hexToBytes;

type Vector = {
  name: string;
  type: number;
  schemas: string[];
  fields: Record<string, unknown>;
  encoded: string;
  reports: string[];
  ble: Record<"20" | "182", string[]>;
};

const vectors = (loadVectors("onekey/messages.json") as { messages: Vector[] }).messages;

const MESSAGES: Readonly<Record<string, MessageDef>> = {
  Initialize,
  Features,
  Success,
  Failure,
  ButtonRequest,
  ButtonAck,
  PinMatrixRequest,
  BixinPinInputOnDevice,
  PassphraseRequest,
  PassphraseAck,
};

const ENCODERS: Readonly<Record<string, MessageDef>> = {
  ...MESSAGES,
  Features: FeaturesOracle,
};

const withVector = vectors.filter((v) => MESSAGES[v.name] !== undefined);

function descriptor(name: string): MessageDef {
  const def = MESSAGES[name];
  if (def === undefined) {
    throw new Error(`no client descriptor for ${name}`);
  }
  return def;
}

function encoderFor(name: string): MessageDef {
  const def = ENCODERS[name];
  if (def === undefined) {
    throw new Error(`no encoder for ${name}`);
  }
  return def;
}

/** Converts the vector's JSON field values (hex bytes, decimal-string u64) to runtime values. */
function toRuntime(fields: Fields, json: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const value = json[name];
    if (value === undefined) {
      continue;
    }
    if (spec.rule === "repeated") {
      if (!Array.isArray(value)) {
        throw new TypeError(`vector field ${name} is not an array`);
      }
      out[name] = value.map((item) => convert(spec, item));
    } else {
      out[name] = convert(spec, value);
    }
  }
  return out;
}

function convert(spec: FieldSpec, item: unknown): unknown {
  if (spec.kind === "bytes") {
    if (typeof item !== "string") {
      throw new TypeError("vector bytes field is not hex");
    }
    return hex(item);
  }
  if (spec.kind === "uint64") {
    if (typeof item !== "string") {
      throw new TypeError("vector uint64 field is not a decimal string");
    }
    return BigInt(item);
  }
  return item;
}

/** The decoded message as a plain record — assertions read descriptor keys only. */
function fields(def: MessageDef, data: Uint8Array): Record<string, unknown> {
  return decode(def, data);
}

function onekeyError(fn: () => unknown): OneKeyError | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

const fault = (fn: () => unknown): OneKeyError => {
  const error = onekeyError(fn);
  if (error?.code !== "device-fault") {
    throw new Error(`expected device-fault, got ${error?.code ?? "no error"}`);
  }
  return error;
};

/** A nested-message byte stream `depth` levels deep: field 1 length-delimited each level. */
function nest(depth: number): Uint8Array {
  if (depth === 0) {
    return new Uint8Array(0);
  }
  return Uint8Array.from([0x0a, nestLen(depth - 1), ...nest(depth - 1)]);
}
const nestLen = (depth: number): number => (depth === 0 ? 0 : 2 + nestLen(depth - 1));

/** The record with absent (undefined) fields dropped — decode never materialises them. */
function presentOnly(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

describe("vector encode", () => {
  it.each(withVector)("encodes $name $fields", (vector) => {
    const def = encoderFor(vector.name);
    const value = toRuntime(def.fields, vector.fields);
    expect(encode(def, value as never)).toStrictEqual(hex(vector.encoded));
  });
});

describe("vector decode", () => {
  it.each(withVector)("decodes $name $fields", (vector) => {
    const def = descriptor(vector.name);
    const decoded = fields(def, hex(vector.encoded));
    for (const [name, spec] of Object.entries(def.fields)) {
      const expectValue = toRuntime({ [name]: spec }, vector.fields)[name];
      expect(decoded[name]).toStrictEqual(expectValue);
    }
  });
});

describe("descriptor completeness", () => {
  it.each(Object.entries(MESSAGES))("%s has a vector with the same type id", (name, def) => {
    const matching = vectors.filter((v) => v.name === name);
    expect(matching.length).toBeGreaterThan(0);
    for (const vector of matching) {
      expect(vector.type).toBe(def.typeId);
    }
  });
});

describe("decode rejections", () => {
  // uint64: the only kind where a full 10-byte varint can decode, so the 10-byte/64-bit limits
  // are observable only through it.
  const u64 = defineMessage(98, { id: { no: 1, kind: "uint64", rule: "optional" } });

  it("rejects a varint longer than 10 bytes", () => {
    // 0x80-terminated: 10 continuation bytes then a terminator — decode would accept under the
    // 11-byte limit.
    expect(fault(() => decode(u64, hex("08ffffffffffffffffff8000")))).toBeDefined();
  });

  it("rejects a varint exceeding 64 bits in a uint64", () => {
    expect(fault(() => decode(u64, hex("08ffffffffffffffffff7f")))).toBeDefined();
  });

  const cases: Array<[string, string, string]> = [
    // [title, hex, descriptor name]
    ["known field on the wrong wire type", "0801", "Success"], // message as varint
    ["non-repeated field twice", "08010802", "Failure"],
    ["varint longer than 10 bytes", "08ffffffffffffffffff7f01", "Failure"],
    ["uint32 field overflowing", "108080808010", "ButtonRequest"], // pages = 2^32
    ["bool field not 0 or 1", "1802", "PassphraseAck"],
    ["length past the end", "0a0541", "Success"],
    ["invalid UTF-8 in a string", "0a01ff", "Success"],
    ["missing required field", "18152000", "Features"], // no major_version
    ["field number 0", "0001", "Failure"],
    ["group wire type 3", "0b", "Failure"],
    ["group wire type 4", "0c", "Failure"],
    ["wire type 6", "0e", "Failure"],
    ["wire type 7", "0f", "Failure"],
    ["truncated varint key", "80", "Failure"],
    ["missing field value", "08", "Failure"],
    ["varint exceeding 64 bits", "08ffffffffffffffffff7f", "Failure"],
    ["non-repeated field on the packed wire type", "0a0101", "Failure"],
    ["unknown field length past the end", "0801fa06050102", "Failure"],
  ];

  it.each(cases)("rejects %s", (_title, input, name) => {
    const error = fault(() => decode(descriptor(name), hex(input)));
    expect(error).toBeDefined();
  });

  it("rejects nesting deeper than 8", () => {
    const d9 = defineMessage(9, {});
    const d8 = defineMessage(8, {
      inner: { no: 1, kind: "message", rule: "optional", message: d9 },
    });
    const d7 = defineMessage(7, {
      inner: { no: 1, kind: "message", rule: "optional", message: d8 },
    });
    const d6 = defineMessage(6, {
      inner: { no: 1, kind: "message", rule: "optional", message: d7 },
    });
    const d5 = defineMessage(5, {
      inner: { no: 1, kind: "message", rule: "optional", message: d6 },
    });
    const d4 = defineMessage(4, {
      inner: { no: 1, kind: "message", rule: "optional", message: d5 },
    });
    const d3 = defineMessage(3, {
      inner: { no: 1, kind: "message", rule: "optional", message: d4 },
    });
    const d2 = defineMessage(2, {
      inner: { no: 1, kind: "message", rule: "optional", message: d3 },
    });
    const d1 = defineMessage(1, {
      inner: { no: 1, kind: "message", rule: "optional", message: d2 },
    });
    // d1 → … → d8 is eight levels: accepted. One more `0a` layer reaches d9 at depth 9.
    expect(decode(d1, nest(7))).toStrictEqual({
      inner: { inner: { inner: { inner: { inner: { inner: { inner: {} } } } } } },
    });
    expect(fault(() => decode(d1, nest(8)))).toBeDefined();
    const value: Record<string, unknown> = {
      inner: { inner: { inner: { inner: { inner: { inner: { inner: { inner: {} } } } } } } },
    };
    const encoded = onekeyError(() => encode(d1, value as never));
    expect(encoded?.code).toBe("invalid-input");
  });
});

describe("encode rejections", () => {
  const uint64s = defineMessage(99, { id: { no: 1, kind: "uint64", rule: "optional" } });

  it("rejects a missing required field", () => {
    const error = onekeyError(() => encode(Features, {} as never));
    expect(error?.code).toBe("invalid-input");
  });

  it("rejects an out-of-range uint32", () => {
    const error = onekeyError(() => encode(Failure, { code: 0x1_00_00_00_00 }));
    expect(error?.code).toBe("invalid-input");
  });

  it("rejects an out-of-range uint64", () => {
    const error = onekeyError(() => encode(uint64s, { id: 2n ** 64n }));
    expect(error?.code).toBe("invalid-input");
  });

  it("rejects a repeated field that is not an array", () => {
    const error = onekeyError(() => encode(Features, { capabilities: 7 } as never));
    expect(error?.code).toBe("invalid-input");
  });

  it("rejects a bad field number and type id", () => {
    expect(
      onekeyError(() => defineMessage(1, { x: { no: 0, kind: "bool", rule: "optional" } }))?.code,
    ).toBe("invalid-input");
    expect(onekeyError(() => defineMessage(0x1_00_00, {}))?.code).toBe("invalid-input");
    expect(onekeyError(() => defineMessage(-1, {}))?.code).toBe("invalid-input");
  });
});

describe("decode acceptance", () => {
  it("skips unknown fields", () => {
    const decoded = fields(Failure, hex("0801980601")); // code=1, unknown field 99 = 1
    expect(decoded["code"]).toBe(1);
  });

  it("skips an unknown fixed64 tail of exactly 8 bytes", () => {
    const decoded = fields(Failure, hex("0801f9060102030405060708"));
    expect(decoded["code"]).toBe(1);
  });

  it("accepts packed repeated scalars", () => {
    // capabilities = field 30 packed varints [1, 2] amid the required version fields.
    const data = hex("100218032004f201020102");
    expect(fields(Features, data)["capabilities"]).toStrictEqual([1, 2]);
  });

  it("merges repeated scalars across unpacked and packed occurrences", () => {
    const data = hex("100218032004f00101f201020203");
    expect(fields(Features, data)["capabilities"]).toStrictEqual([1, 2, 3]);
  });

  it("rejects a packed run whose last varint continues past its end", () => {
    // All required fields precede it so only the overrun is wrong: capabilities packed length 2
    // = "01 80" — the trailing varint's continuation bit would read the next field's tag (32)
    // into the run, silently producing capabilities [1, 6400] on an unchecked decoder.
    const error = fault(() => decode(Features, hex("100218032004f201020180320141")));
    expect(error).toBeDefined();
  });

  it("keeps a leading BOM as U+FEFF in a string field", () => {
    const decoded = decode(Success, hex("0a04efbbbf61"));
    expect(decoded.message).toBe("\uFEFFa");
  });

  it("round-trips through encode", () => {
    for (const vector of withVector) {
      const def = descriptor(vector.name);
      const decoded = fields(def, hex(vector.encoded));
      expect(decoded).toStrictEqual(presentOnly(toRuntime(def.fields, vector.fields)));
    }
  });
});
