// oxlint-disable vitest/expect-expect -- assertions live in the decodes/integrity/code helpers
/**
 * The strict CBOR subset: canonical encodings of every supported type decode, and every deviation —
 * truncated or non-shortest heads, indefinite containers, duplicate map keys, trailing bytes,
 * over-deep nesting, over-wide containers, invalid UTF-8, unsupported majors — is `integrity`,
 * never another error. Random bytes can only produce a value or a KernelError, and encoding
 * re-reads byte-identically.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { KernelError } from "../src/errors.ts";
import type { Cbor } from "../src/modules/signers/keystone/cbor.ts";
import { decodeCbor, encodeCbor } from "../src/modules/signers/keystone/cbor.ts";

const code = (bytes: Uint8Array): string => {
  try {
    decodeCbor(bytes);
    return "no-error";
  } catch (error) {
    return error instanceof KernelError ? error.code : "not-a-kernel-error";
  }
};

const decodes = (hex: string, want: Cbor): void => {
  expect(decodeCbor(hexToBytes(hex))).toStrictEqual(want);
};

const integrity = (hex: string): void => {
  expect(code(hexToBytes(hex))).toBe("integrity");
};

const depth = (tree: Cbor): number => {
  switch (tree.kind) {
    case "array":
      return 1 + Math.max(0, ...tree.items.map(depth));
    case "map":
      return 1 + Math.max(0, ...tree.entries.flatMap(([k, v]) => [depth(k), depth(v)]));
    case "tag":
      return 1 + depth(tree.item);
    default:
      return 1;
  }
};

/** Map entries with duplicate keys removed — the arbitrary may generate them. */
const deduped = (pairs: ReadonlyArray<readonly [number, Cbor]>): Cbor => {
  const seen = new Set<number>();
  const entries: Array<[Cbor, Cbor]> = [];
  for (const [key, value] of pairs) {
    if (!seen.has(key)) {
      seen.add(key);
      entries.push([{ kind: "uint", value: key }, value]);
    }
  }
  return { kind: "map", entries };
};

describe("decodeCbor canonical values", () => {
  it("decodes the head boundary values", () => {
    decodes("00", { kind: "uint", value: 0 });
    decodes("17", { kind: "uint", value: 23 });
    decodes("1818", { kind: "uint", value: 24 });
    decodes("18ff", { kind: "uint", value: 255 });
    decodes("190100", { kind: "uint", value: 256 });
    decodes("19ffff", { kind: "uint", value: 65535 });
    decodes("1a00010000", { kind: "uint", value: 65536 });
    decodes("1affffffff", { kind: "uint", value: 0xffffffff });
    decodes("1b0000000100000000", { kind: "uint", value: 2 ** 32 });
    decodes("1b001fffffffffffff", { kind: "uint", value: Number.MAX_SAFE_INTEGER });
  });

  it("decodes bytes, text, arrays, maps, tags and booleans", () => {
    decodes("40", { kind: "bytes", value: new Uint8Array(0) });
    decodes("42dead", { kind: "bytes", value: hexToBytes("dead") });
    decodes("60", { kind: "text", value: "" });
    decodes("62c3a9", { kind: "text", value: "é" });
    decodes("82f5f4", {
      kind: "array",
      items: [
        { kind: "bool", value: true },
        { kind: "bool", value: false },
      ],
    });
    decodes("a201020304", {
      kind: "map",
      entries: [
        [
          { kind: "uint", value: 1 },
          { kind: "uint", value: 2 },
        ],
        [
          { kind: "uint", value: 3 },
          { kind: "uint", value: 4 },
        ],
      ],
    });
    decodes("d9012f00", { kind: "tag", tag: 303, item: { kind: "uint", value: 0 } });
  });
});

describe("decodeCbor malformed input is integrity", () => {
  it("rejects empty and truncated input", () => {
    expect(code(new Uint8Array(0))).toBe("integrity");
    integrity("18");
    integrity("581841");
    integrity("a20102");
    integrity("d8");
  });

  it("rejects non-shortest heads", () => {
    integrity("1817"); // 23 in a one-byte slot
    integrity("1900ff"); // 255 in a two-byte slot
    integrity("1a0000ffff"); // 65535 in a four-byte slot
    integrity("1b00000000ffffffff"); // 2^32-1 in an eight-byte slot
    integrity("5800"); // empty byte string with a one-byte length
    integrity("7800"); // empty text with a one-byte length
    integrity("9801f5"); // one-item array with a two-byte count
    integrity("b800");
  });

  it("rejects indefinite and reserved heads", () => {
    integrity("9fff");
    integrity("bfff");
    integrity("5f41aaff");
    integrity("7f61aaff");
    integrity("ff");
    integrity("1c");
    integrity("1d");
    integrity("1e");
  });

  it("rejects types outside the subset", () => {
    integrity("20"); // negative int
    integrity("3bffffffffffffffff");
    integrity("f6"); // null
    integrity("f7"); // undefined
    integrity("f820"); // simple
    integrity("f93c00"); // half float
    integrity("fa47c35000"); // float32
    integrity("fb7ff0000000000000"); // float64
  });

  it("rejects duplicate map keys", () => {
    integrity("a200000001");
    integrity("a241aa0141aa02");
  });

  it("rejects trailing bytes", () => {
    integrity("0000");
    integrity("f500");
    integrity("410000");
  });

  it("rejects depth beyond eight and breadth beyond the item cap", () => {
    // Nine nested one-item arrays: the ninth inner item is depth 9.
    integrity(`${"81".repeat(9)}00`);
    decodes(`${"81".repeat(7)}00`, {
      kind: "array",
      items: [
        {
          kind: "array",
          items: [
            {
              kind: "array",
              items: [
                {
                  kind: "array",
                  items: [
                    {
                      kind: "array",
                      items: [
                        {
                          kind: "array",
                          items: [
                            {
                              kind: "array",
                              items: [{ kind: "uint", value: 0 }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    integrity("9a00001001"); // array of 4097
    integrity("ba00001001"); // map of 4097 pairs
    integrity("9bffffffffffffffff"); // array of 2^64-1
  });

  it("rejects invalid UTF-8 text and oversized input", () => {
    integrity("61ff");
    integrity("62c328");
    integrity("62e080");
    expect(code(new Uint8Array(262145))).toBe("integrity");
  });

  it("rejects integer arguments beyond the safe range", () => {
    integrity("1b0020000000000000"); // 2^53
    integrity("1bffffffffffffffff");
  });
});

describe("encodeCbor", () => {
  it("serialises canonical heads", () => {
    const cases: ReadonlyArray<[Cbor, string]> = [
      [{ kind: "uint", value: 0 }, "00"],
      [{ kind: "uint", value: 23 }, "17"],
      [{ kind: "uint", value: 24 }, "1818"],
      [{ kind: "uint", value: 256 }, "190100"],
      [{ kind: "uint", value: 65536 }, "1a00010000"],
      [{ kind: "uint", value: 2 ** 32 }, "1b0000000100000000"],
      [{ kind: "bytes", value: hexToBytes("dead") }, "42dead"],
      [{ kind: "text", value: "é" }, "62c3a9"],
      [{ kind: "bool", value: true }, "f5"],
      [{ kind: "bool", value: false }, "f4"],
      [{ kind: "tag", tag: 303, item: { kind: "uint", value: 0 } }, "d9012f00"],
      [
        {
          kind: "map",
          entries: [
            [
              { kind: "uint", value: 1 },
              { kind: "array", items: [{ kind: "bool", value: true }] },
            ],
          ],
        },
        "a10181f5",
      ],
    ];
    for (const [tree, hex] of cases) {
      expect(hexToBytes(hex)).toStrictEqual(encodeCbor(tree));
      expect(decodeCbor(hexToBytes(hex))).toStrictEqual(tree);
    }
  });
});

describe("decoder properties", () => {
  it("random bytes throw only KernelError", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        expect(code(bytes)).not.toBe("not-a-kernel-error");
      }),
    );
  });

  it("encode then decode round-trips every tree", () => {
    const leaf: fc.Arbitrary<Cbor> = fc.oneof(
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map((value) => ({
        kind: "uint" as const,
        value,
      })),
      fc.uint8Array({ maxLength: 64 }).map((value) => ({ kind: "bytes" as const, value })),
      fc.string().map((value) => ({ kind: "text" as const, value })),
      fc.boolean().map((value) => ({ kind: "bool" as const, value })),
    );
    const { node } = fc.letrec<{ node: Cbor }>((tie) => ({
      node: fc.oneof(
        { depthSize: "small" },
        leaf,
        fc.array(tie("node"), { maxLength: 4 }).map((items) => ({
          kind: "array" as const,
          items,
        })),
        fc
          .array(fc.tuple(fc.integer({ min: 0, max: 0xffffffff }), tie("node")), {
            maxLength: 4,
          })
          .map(deduped),
        fc
          .tuple(fc.integer({ min: 0, max: 0xffffffff }), tie("node"))
          .map(([tag, item]) => ({ kind: "tag" as const, tag, item })),
      ),
    }));
    fc.assert(
      fc.property(node, (tree) => {
        fc.pre(depth(tree) <= 8);
        expect(decodeCbor(encodeCbor(tree))).toStrictEqual(tree);
      }),
    );
  });
});
