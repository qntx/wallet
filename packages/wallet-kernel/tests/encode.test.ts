import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { encodeBase58Ascii, encodeHexAscii } from "../src/secret/encode.ts";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("encodeHexAscii", () => {
  it("matches bytesToHex on generated inputs", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (input) => {
        expect(decode(encodeHexAscii(input))).toBe(`0x${bytesToHex(input)}`);
      }),
    );
  });

  it("encodes the fixed cases", () => {
    expect(decode(encodeHexAscii(new Uint8Array(0)))).toBe("0x");
    expect(decode(encodeHexAscii(new Uint8Array([0])))).toBe("0x00");
    expect(decode(encodeHexAscii(new Uint8Array([0, 0, 1])))).toBe("0x000001");
    expect(decode(encodeHexAscii(new Uint8Array(32).fill(0xab)))).toBe(`0x${"ab".repeat(32)}`);
    expect(decode(encodeHexAscii(new Uint8Array(64).fill(0xab)))).toBe(`0x${"ab".repeat(64)}`);
  });
});

describe("encodeBase58Ascii", () => {
  it("matches @scure/base base58 on generated inputs, leading zeros included", () => {
    fc.assert(
      fc.property(
        // Prefix a generated run of zero bytes so every input shape hits the '1' path.
        fc.tuple(fc.uint8Array({ maxLength: 16 }), fc.uint8Array({ maxLength: 80 })),
        ([zeros, rest]) => {
          const input = new Uint8Array([...zeros.map(() => 0), ...rest]);
          expect(decode(encodeBase58Ascii(input))).toBe(base58.encode(input));
        },
      ),
    );
  });

  it("encodes the fixed cases", () => {
    expect(decode(encodeBase58Ascii(new Uint8Array(0)))).toBe("");
    expect(decode(encodeBase58Ascii(new Uint8Array([0])))).toBe("1");
    expect(decode(encodeBase58Ascii(new Uint8Array([0, 0, 1])))).toBe("112");
    for (const length of [32, 64]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) % 256);
      expect(decode(encodeBase58Ascii(bytes))).toBe(base58.encode(bytes));
    }
  });
});
