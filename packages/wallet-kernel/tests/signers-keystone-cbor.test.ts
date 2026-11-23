// oxlint-disable vitest/expect-expect -- assertions live in the decodes/integrity/code helpers
/**
 * The registry decode boundary: `decodeRegistry` runs dcbor (strict — definite lengths,
 * shortest-form heads, distinct ordered map keys, valid UTF-8, no trailing bytes) plus the one
 * registry codec, and maps every failure — `CborError`, `UrError`, the host `RangeError` of a
 * stack-exhausting nest — to `KernelError("integrity")`. Truncated, oversized, mis-typed and
 * over-deep input can only produce a value or a KernelError, never an untyped throw or a hang. The
 * local codecs (btc-sign-request, btc-signature, qr-hardware-call — the types @qntx/ur lacks) are
 * additionally exercised: closed maps, exact lengths, `#6.37` request ids.
 */
import { CborMap, Tag, cbor, encodeCbor, taggedValue } from "@blockchaincommons/dcbor";
import type { CborInput } from "@blockchaincommons/dcbor";
import { hexToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { cryptoMultiAccountsCodec } from "@qntx/ur/interop";
import type { UrCodec } from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";

import { KernelError } from "../src/errors.ts";
import {
  btcSignatureCodec,
  btcSignRequestCodec,
  decodeRegistry,
  qrHardwareCallCodec,
} from "../src/modules/signers/keystone/registry.ts";

/**
 * Foreign (non-KernelError) failure escapes `decodeRegistry` — undefined when only integrity is
 * thrown.
 */
const foreignFailure = (bytes: Uint8Array, codec: UrCodec<unknown>): unknown => {
  try {
    decodeRegistry(bytes, codec);
    return undefined;
  } catch (error) {
    return error instanceof KernelError ? undefined : error;
  }
};

const code = (bytes: Uint8Array): string => {
  try {
    decodeRegistry(bytes, btcSignatureCodec);
    return "no-error";
  } catch (error) {
    return error instanceof KernelError ? error.code : "not-a-kernel-error";
  }
};

const integrity = (hex: string): void => {
  expect(code(hexToBytes(hex))).toBe("integrity");
};

const mapBytes = (entries: ReadonlyArray<readonly [number, CborInput]>): Uint8Array =>
  encodeCbor(new CborMap(new Map<number, CborInput>(entries)));

describe("decodeRegistry malformed input is integrity", () => {
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
    integrity("1c20");
    integrity("1dff");
    integrity("1eaa");
    integrity("1f20");
  });

  it("rejects types outside the registry shape", () => {
    integrity("20"); // negative int — dcbor decodes it, the codec refuses a non-map
    integrity("f6"); // null
    integrity("f7"); // undefined
    integrity("f820"); // simple
    integrity("f93c00"); // half float
    integrity("fa47c35000"); // float32
    integrity("fb7ff0000000000000"); // float64
  });

  it("rejects duplicate and misordered map keys", () => {
    integrity("a200000001");
    integrity("a241aa0141aa02");
    integrity("a203020102"); // keys written out of canonical order
  });

  it("rejects trailing bytes", () => {
    integrity("0000");
    integrity("f500");
    integrity("410000");
  });

  it("rejects over-deep and over-wide input without looping or a stack crash", () => {
    // Nine nested one-item arrays are a valid dCBOR value but not a registry body.
    integrity(`${"81".repeat(9)}00`);
    // A nest deep enough to exhaust the call stack still surfaces only integrity.
    integrity(`${"81".repeat(10000)}00`);
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
});

describe("local codecs", () => {
  const REQUEST_ID = hexToBytes("00112233445566778899aabbccddeeff");
  const SIGNATURE = new Uint8Array(65).fill(7);
  const PUBLIC_KEY = new Uint8Array(33).fill(9);

  it("btc-signature decodes a vendor-shaped map and re-encodes identically", () => {
    const value = { requestId: REQUEST_ID, signature: SIGNATURE, publicKey: PUBLIC_KEY };
    const bytes = encodeCbor(btcSignatureCodec.encode(value));
    expect(decodeRegistry(bytes, btcSignatureCodec)).toStrictEqual(value);
  });

  it("btc-signature refuses any field-shape deviation", () => {
    const idField: [number, CborInput] = [1, taggedValue(Tag.from(37), REQUEST_ID)];
    const sigField: [number, CborInput] = [2, SIGNATURE];
    const keyField: [number, CborInput] = [3, PUBLIC_KEY];
    // Closed map: a foreign key or a missing field. The request id is
    // optional on the wire — the kernel's request-id check refuses it instead.
    expect(code(mapBytes([idField, sigField, keyField, [4, new Uint8Array(0)]]))).toBe("integrity");
    expect(code(mapBytes([idField, keyField]))).toBe("integrity");
    expect(code(mapBytes([idField, sigField]))).toBe("integrity");
    expect(code(mapBytes([sigField, keyField]))).toBe("no-error");
    // Exact lengths: 64-byte signature, 32-byte key, 15-byte request id.
    expect(code(mapBytes([idField, [2, new Uint8Array(64)], keyField]))).toBe("integrity");
    expect(code(mapBytes([idField, sigField, [3, new Uint8Array(32)]]))).toBe("integrity");
    expect(
      code(mapBytes([[1, taggedValue(Tag.from(37), new Uint8Array(15))], sigField, keyField])),
    ).toBe("integrity");
    // The request id under a foreign tag is not a request id.
    expect(code(mapBytes([[1, taggedValue(Tag.from(36), REQUEST_ID)], sigField, keyField]))).toBe(
      "integrity",
    );
    // Untagged request id — also refused.
    expect(code(mapBytes([[1, REQUEST_ID], sigField, keyField]))).toBe("integrity");
  });

  it("btc-sign-request round-trips and refuses non-message data types", () => {
    const path = {
      components: [{ kind: "index" as const, index: 0, hardened: true }],
      sourceFingerprint: 0xdeadbeef,
    };
    const value = {
      requestId: REQUEST_ID,
      signData: hexToBytes("aabb"),
      derivationPaths: [path],
      origin: "qntx",
    };
    const bytes = encodeCbor(btcSignRequestCodec.encode(value));
    expect(decodeRegistry(bytes, btcSignRequestCodec)).toStrictEqual(value);
    // dataType 2 is not a message request.
    const bad = decodeRegistry(bytes, btcSignRequestCodec);
    expect(bad.signData).toStrictEqual(hexToBytes("aabb"));
    const tampered = mapBytes([
      [1, taggedValue(Tag.from(37), REQUEST_ID)],
      [2, hexToBytes("aabb")],
      [3, 2],
      [4, [keypathTag(path)]],
      [6, "qntx"],
    ]);
    expect(code(tampered)).toBe("integrity");
  });

  const keypathTag = (path: {
    components: ReadonlyArray<{ kind: "index"; index: number; hardened: boolean }>;
    sourceFingerprint: number;
  }): ReturnType<typeof taggedValue> => {
    const map = new CborMap();
    map.set(
      1,
      path.components.flatMap((component) => [component.index, component.hardened]),
    );
    map.set(2, path.sourceFingerprint);
    return taggedValue(Tag.from(304, "crypto-keypath"), cbor(map));
  };

  it("qr-hardware-call round-trips and refuses foreign shapes", () => {
    const path = {
      components: [{ kind: "index" as const, index: 44, hardened: true }],
      sourceFingerprint: 0xdeadbeef,
    };
    const value = { schemas: [{ path, curve: 1 as const }], origin: "qntx" };
    const bytes = encodeCbor(qrHardwareCallCodec.encode(value));
    expect(decodeRegistry(bytes, qrHardwareCallCodec)).toStrictEqual(value);
    // Call-type ≠ 0 is not a key-derivation call.
    const call = new CborMap();
    call.set(1, [
      taggedValue(
        Tag.from(1302, "key-derivation-schema"),
        cbor(
          new CborMap(
            new Map<number, CborInput>([
              [1, keypathTag(path)],
              [2, 1],
              [3, 0],
            ]),
          ),
        ),
      ),
    ]);
    const tampered = encodeCbor(
      new CborMap(
        new Map<number, CborInput>([
          [1, 9],
          [2, taggedValue(Tag.from(1301, "key-derivation-call"), cbor(call))],
          [3, "qntx"],
        ]),
      ),
    );
    expect(code(tampered)).toBe("integrity");
  });
});

describe("decodeRegistry properties", () => {
  it("random bytes throw only KernelError", () => {
    const codecs: ReadonlyArray<UrCodec<unknown>> = [
      btcSignatureCodec,
      cryptoMultiAccountsCodec,
      cryptoPsbtCodec,
    ];
    for (const codec of codecs) {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
          expect(foreignFailure(bytes, codec)).toBeUndefined();
        }),
      );
    }
  });

  it("a codec that throws a foreign error still surfaces integrity", () => {
    const hostile: UrCodec<never> = {
      tags: [Tag.from(1, "x")],
      encode: () => {
        throw new TypeError("foreign");
      },
      decode: () => {
        throw new RangeError("stack");
      },
    };
    expect(() => decodeRegistry(mapBytes([]), hostile)).toThrow(KernelError);
  });
});
