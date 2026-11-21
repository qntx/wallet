/** The strict protobuf wire reader/writer: acceptance shapes plus every rejection rule. */
// oxlint-disable vitest/expect-expect -- malformed-input factories wrap the expect calls
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import {
  bytesField,
  encodeMessage,
  equalBytes,
  readFields,
  readVarint,
  stringField,
  varintField,
  writeVarint,
} from "../src/tron/proto.ts";
import type { ProtoField } from "../src/tron/proto.ts";

const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const of = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

const malformed = (run: () => unknown): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).code).toBe("invalid-request");
    return;
  }
  throw new Error("expected ChainError");
};

describe("readVarint", () => {
  it("accepts canonical varints", () => {
    expect(readVarint(of(0), 0)).toStrictEqual({ value: 0n, next: 1 });
    expect(readVarint(of(0x7f), 0)).toStrictEqual({ value: 127n, next: 1 });
    expect(readVarint(of(0x80, 0x01), 0)).toStrictEqual({ value: 128n, next: 2 });
    expect(readVarint(of(0xac, 0x02), 0)).toStrictEqual({ value: 300n, next: 2 });
  });

  it("accepts a 10-byte maximum varint at the uint64 top", () => {
    // 2^64 - 1: nine 0xff continuation bytes then 0x01
    const max = readVarint(of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01), 0);
    expect(max.value).toBe(2n ** 64n - 1n);
    expect(max.next).toBe(10);
    // 2^63: eight 0x80 continuation bytes, 0x80, 0x01
    expect(
      readVarint(of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01), 0).value,
    ).toBe(2n ** 63n);
  });

  it("rejects 11-byte varints and values over 64 bits", () => {
    malformed(() =>
      readVarint(of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01), 0),
    );
    malformed(() => readVarint(of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02), 0));
    malformed(() => readVarint(of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f), 0));
  });

  it("rejects non-minimal encodings", () => {
    malformed(() => readVarint(of(0x80, 0x00), 0)); // zero in two bytes
    malformed(() => readVarint(of(0x81, 0x00), 0)); // one in two bytes
    malformed(() => readVarint(of(0xac, 0x82, 0x00), 0)); // trailing 0x80…0x00
    malformed(() => readVarint(of(0xff, 0x80, 0x00), 0));
  });

  it("rejects truncation", () => {
    malformed(() => readVarint(of(0x80), 0));
    malformed(() => readVarint(of(0xff, 0xff), 0));
    malformed(() => readVarint(new Uint8Array(0), 0));
  });
});

describe("writeVarint", () => {
  it("round-trips canonical values", () => {
    for (const v of [0n, 1n, 127n, 128n, 300n, 2n ** 32n, 2n ** 63n, 2n ** 64n - 1n]) {
      const encoded = writeVarint(v);
      expect(readVarint(encoded, 0).value).toBe(v);
      expect(readVarint(encoded, 0).next).toBe(encoded.length);
    }
    expect([...writeVarint(0n)]).toStrictEqual([0]);
    expect([...writeVarint(128n)]).toStrictEqual([0x80, 0x01]);
  });
});

describe("readFields", () => {
  it("iterates ascending fields", () => {
    const fields = readFields(hex("08011002180a"));
    expect(fields.map((f) => f.field)).toStrictEqual([1, 2, 3]);
    expect(fields.map((f) => f.varint)).toStrictEqual([1n, 2n, 10n]);
    expect(fields[0]?.wire).toBe(0);
  });

  it("captures the whole encoded slice, tag included", () => {
    const fields = readFields(hex("12030a0102189601"));
    expect(fields[0]?.bytes).toStrictEqual(hex("12030a0102"));
    expect(fields[0]?.data).toStrictEqual(of(0x0a, 0x01, 0x02));
    expect(fields[1]?.bytes).toStrictEqual(hex("189601"));
  });

  it("allows a declared repeated field to repeat consecutively", () => {
    const fields = readFields(hex("12010a12010b1810"), [2]);
    expect(fields.map((f) => f.field)).toStrictEqual([2, 2, 3]);
  });

  it("rejects a repeated field appearing non-consecutively", () => {
    malformed(() => readFields(hex("12010a181012010b"), [2]));
  });

  it("rejects duplicates of a non-repeated field", () => {
    malformed(() => readFields(hex("08010802")));
    malformed(() => readFields(hex("12010a12010b")));
  });

  it("rejects descending and equal-non-repeated order", () => {
    malformed(() => readFields(hex("180a0801")));
    malformed(() => readFields(hex("12010a0801")));
  });

  it("rejects group and reserved wire types", () => {
    malformed(() => readFields(hex("0b0801100c"))); // field 1 start-group / end-group
    malformed(() => readFields(hex("0e"))); // wire 6
    malformed(() => readFields(hex("0f"))); // wire 7
    malformed(() => readFields(hex("13"))); // field 2 wire 3
  });

  it("accepts fixed 32/64 fields for unknown-field capture", () => {
    const fields = readFields(hex("0901020304050607081511223344"));
    expect(fields[0]?.wire).toBe(1);
    expect(fields[0]?.data).toStrictEqual(of(1, 2, 3, 4, 5, 6, 7, 8));
    expect(fields[1]?.wire).toBe(5);
    expect(fields[1]?.data).toStrictEqual(of(0x11, 0x22, 0x33, 0x44));
  });

  it("rejects length-delimited fields past the end", () => {
    malformed(() => readFields(hex("12050a0102")));
    malformed(() => readFields(hex("1203")));
    malformed(() => readFields(hex("09"))); // fixed64 truncated
    malformed(() => readFields(hex("15"))); // fixed32 truncated
  });

  it("rejects field number 0 and truncated tags", () => {
    malformed(() => readFields(hex("00")));
    malformed(() => readFields(hex("80")));
  });
});

describe("encodeMessage", () => {
  it("emits fields in order and omits proto3 defaults", () => {
    const encoded = encodeMessage([
      { field: 1, bytes: varintField(1, 5n) },
      { field: 2, bytes: varintField(2, 0n) }, // default — dropped
      { field: 3, bytes: bytesField(3, new Uint8Array(0)) }, // empty — dropped
      { field: 4, bytes: stringField(4, "hi") },
      { field: 5, bytes: stringField(5, "") }, // empty — dropped
    ]);
    expect(encoded).toStrictEqual(hex("080522026869"));
  });

  it("merges captured extras into field-number position", () => {
    const extra: ProtoField = {
      field: 3,
      wire: 2,
      bytes: hex("1a02aabb"),
      varint: undefined,
      data: of(0xaa, 0xbb),
    };
    const encoded = encodeMessage([
      { field: 1, bytes: varintField(1, 1n) },
      { field: 5, bytes: varintField(5, 9n) },
      { field: extra.field, bytes: extra.bytes },
    ]);
    expect(encoded).toStrictEqual(hex("08011a02aabb2809"));
  });

  it("round-trips writeVarint through readVarint for boundaries", () => {
    expect(
      equalBytes(
        writeVarint(2n ** 64n - 1n),
        of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01),
      ),
    ).toBe(true);
  });
});
