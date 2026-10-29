import { readFileSync } from "node:fs";
import { join } from "node:path";

import { encode } from "cborg";
// oxlint-disable eslint/no-bitwise, unicorn/prefer-math-trunc, eslint/operator-assignment -- the seeded PRNG is inherently bitwise.
import { describe, expect, it } from "vite-plus/test";

import { decodeFrame, encodeFrame, CborError, FRAME_MAX_BYTES } from "../src/cbor.ts";

type VectorCase = { name: string; frame: string; expect: "ok" | "reject"; reason?: string };
const vectors: { cases: VectorCase[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/native-frames.json"), "utf8"),
) as { cases: VectorCase[] };

it.each(vectors.cases.filter((x) => x.expect === "ok"))(
  "native-frames vectors: accept $name",
  (c: VectorCase) => {
    const frame = Uint8Array.from(Buffer.from(c.frame, "hex"));
    const decoded = decodeFrame(frame);
    expect(new Uint8Array(encodeFrame(decoded))).toStrictEqual(frame);
  },
);

it.each(vectors.cases.filter((x) => x.expect === "reject"))(
  "native-frames vectors: reject $name",
  (c: VectorCase) => {
    const frame = Uint8Array.from(Buffer.from(c.frame, "hex"));
    expect(() => decodeFrame(frame)).toThrow(CborError);
    expect(() => decodeFrame(frame)).toThrow(expect.objectContaining({ code: c.reason }));
  },
);

describe("property round trip", () => {
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const LEAVES: unknown[] = [
    null,
    true,
    false,
    0,
    -7,
    Number.MAX_SAFE_INTEGER,
    "",
    "s",
    new Uint8Array(3),
  ];
  const randomValue = (rand: () => number, depth: number): unknown => {
    const pick = rand();
    if (depth <= 0 || pick < 0.14) {
      return LEAVES[Math.trunc(rand() * LEAVES.length)];
    }
    if (pick < 0.6) {
      return Array.from({ length: Math.trunc(rand() * 5) }, () => randomValue(rand, depth - 1));
    }
    return Object.fromEntries(
      Array.from({ length: Math.trunc(rand() * 5) }, (_, i) => [
        `k${i}`,
        randomValue(rand, depth - 1),
      ]),
    );
  };

  it("random ProtocolValue trees encode/decode identically", () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 200; i += 1) {
      const value = randomValue(rand, 4) as Parameters<typeof encodeFrame>[0];
      expect(decodeFrame(encodeFrame(value))).toStrictEqual(value);
    }
  });
});

describe("frame caps and post-decode validation", () => {
  it("rejects an oversized frame on decode", () => {
    expect(() => decodeFrame(new Uint8Array(FRAME_MAX_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "oversize" }),
    );
  });

  it("rejects encoding a value that exceeds 1 MiB", () => {
    expect(() => encodeFrame(new Uint8Array(FRAME_MAX_BYTES))).toThrow(
      expect.objectContaining({ code: "oversize" }),
    );
  });

  it("rejects floats even when cborg decodes them", () => {
    expect(() => decodeFrame(encode(0.5))).toThrow(expect.objectContaining({ code: "float" }));
  });
});
