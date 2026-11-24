// oxlint-disable vitest/expect-expect -- assertions live in the integrity/code helpers
/**
 * The driver's UR decode edge: every malformed or hostile device answer — truncated or non-shortest
 * heads, indefinite containers, duplicate or misordered map keys, trailing bytes, hostile nesting,
 * invalid or non-canonical UTF-8, oversized input, random garbage — ends in a typed
 * `KernelError("integrity")`, never an untyped error. The decoders are `@qntx/ur`'s dCBOR codecs
 * behind `decodeUr`; these cases run through the sync answer entry (`parseSync`) and the
 * signature/psbt codecs exactly as the sign exchange calls them.
 */
import { CborMap, Tag, cbor, encodeCbor, taggedValue } from "@blockchaincommons/dcbor";
import type { CborInput } from "@blockchaincommons/dcbor";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  cryptoMultiAccountsCodec,
  ethSignatureCodec,
  solSignatureCodec,
  tronSignatureCodec,
} from "@qntx/ur/interop";
import { cryptoPsbtCodec } from "@qntx/ur/registry";
import type { UrCodec } from "@qntx/ur/typed";
import type { DeviceResponse } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { parseSync } from "../src/modules/signers/keystone/sync.ts";
import {
  btcSignatureCodec,
  btcSignRequestCodec,
  decodeUr,
  encodeUr,
  qrHardwareCallCodec,
} from "../src/modules/signers/keystone/ur.ts";

const qrResponse = (cbor: Uint8Array, type = "crypto-multi-accounts"): DeviceResponse => ({
  kind: "qr",
  ur: { type, cbor },
});

const code = (run: () => unknown): string => {
  try {
    run();
    return "no-error";
  } catch (error) {
    return error instanceof KernelError ? error.code : "not-a-kernel-error";
  }
};

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const decode = (bytes: Uint8Array): unknown =>
  decodeUr("crypto-multi-accounts", bytes, cryptoMultiAccountsCodec);

const integrity = (hexBytes: string): void => {
  expect(code(() => decode(hex(hexBytes)))).toBe("integrity");
  expect(code(() => parseSync(qrResponse(hex(hexBytes))))).toBe("integrity");
};

describe("malformed multi-accounts answers are integrity", () => {
  it("rejects empty, truncated and trailing input", () => {
    expect(code(() => decode(new Uint8Array(0)))).toBe("integrity");
    integrity("18");
    integrity("581841");
    integrity("a20102");
    integrity("d8");
    integrity("a1010000");
    integrity("a10100ff");
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

  it("rejects structures outside the registry shape", () => {
    // dCBOR decodes negative ints, floats and simple values the retired subset refused; the
    // closed-map codec still closes on them — every one ends in integrity.
    integrity("00");
    integrity("20");
    integrity("f6"); // null
    integrity("f7"); // undefined
    integrity("f820");
    integrity("f93c00");
    integrity("fb7ff0000000000000");
    integrity("a1201a01020304"); // negative-int key
  });

  it("rejects duplicate and misordered map keys", () => {
    integrity("a200000001");
    integrity("a241aa0141aa02");
    integrity("a2011a01020304011a05060708"); // field 1 twice
    integrity("a202000100"); // key 2 before key 1 — dCBOR requires canonical order
  });

  it("rejects invalid and non-canonical UTF-8 text", () => {
    integrity("61ff");
    integrity("62c328");
    integrity("62e080");
    integrity("a1036565cc81"); // "é" decomposed — dCBOR wants NFC
  });

  it("rejects hostile nesting and oversized input", () => {
    integrity(`${"81".repeat(4096)}00`);
    expect(code(() => decode(new Uint8Array(262_145)))).toBe("integrity");
  });
});

describe("hostile signature and psbt answers are integrity", () => {
  const SIGNATURE_CODECS: ReadonlyArray<readonly [string, UrCodec<unknown>]> = [
    ["eth-signature", ethSignatureCodec],
    ["sol-signature", solSignatureCodec],
    ["tron-signature", tronSignatureCodec],
    ["btc-signature", btcSignatureCodec],
    ["crypto-psbt", cryptoPsbtCodec],
  ];
  const SIGNATURE_MAP_CODECS = SIGNATURE_CODECS.filter(([type]) => type !== "crypto-psbt");

  it("random bytes only ever throw KernelError", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
        for (const [type, codec] of SIGNATURE_CODECS) {
          expect(code(() => decodeUr(type, bytes, codec))).not.toBe("not-a-kernel-error");
        }
      }),
    );
  });

  it("rejects well-formed CBOR under a foreign UR type", () => {
    // A structurally valid btc-signature map read as an eth-signature: the 64-byte signature
    // field fails the eth codec's 65..72 bound; as btc-signature it decodes.
    const signature = hex(
      `a301d8255000112233445566778899aabbccddeeff025840${"aa".repeat(64)}03582102${"bb".repeat(
        32,
      )}`,
    );
    expect(code(() => decodeUr("eth-signature", signature, ethSignatureCodec))).toBe("integrity");
    expect(code(() => decodeUr("btc-signature", signature, btcSignatureCodec))).toBe("no-error");
  });

  it("rejects maps with keys outside the closed set", () => {
    // {1: #37(uuid), 2: sig, 4: extra} — key 4 is not a signature field.
    const extra = hex(`a301d8255000112233445566778899aabbccddeeff025840${"aa".repeat(64)}0441aa`);
    for (const [type, codec] of SIGNATURE_MAP_CODECS) {
      expect(code(() => decodeUr(type, extra, codec))).toBe("integrity");
    }
  });

  it("rejects a wrapped tag where the bare body belongs", () => {
    // eth-signature carries its type in the UR name — a #6.402-wrapped body is wrong type.
    const wrapped = hex(`d90192a1025840${"aa".repeat(64)}`);
    expect(code(() => decodeUr("eth-signature", wrapped, ethSignatureCodec))).toBe("integrity");
  });
});

describe("local codecs", () => {
  const REQUEST_ID = hex("00112233445566778899aabbccddeeff");
  const SIGNATURE = new Uint8Array(65).fill(7);
  const PUBLIC_KEY = new Uint8Array(33).fill(9);
  const codeOf = (type: string, bytes: Uint8Array, codec: UrCodec<unknown>): string =>
    code(() => decodeUr(type, bytes, codec));
  const mapBytes = (entries: ReadonlyArray<readonly [number, CborInput]>): Uint8Array =>
    encodeCbor(new CborMap(new Map<number, CborInput>(entries)));
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

  it("btc-signature decodes a vendor-shaped map and re-encodes identically", () => {
    const value = { requestId: REQUEST_ID, signature: SIGNATURE, publicKey: PUBLIC_KEY };
    const bytes = encodeUr(value, btcSignatureCodec);
    expect(decodeUr("btc-signature", bytes, btcSignatureCodec)).toStrictEqual(value);
  });

  it("btc-signature refuses any field-shape deviation", () => {
    const idField: [number, CborInput] = [1, taggedValue(Tag.from(37), REQUEST_ID)];
    const sigField: [number, CborInput] = [2, SIGNATURE];
    const keyField: [number, CborInput] = [3, PUBLIC_KEY];
    // Closed map: a foreign key or a missing field. The request id is
    // optional on the wire — the kernel's request-id check refuses it instead.
    expect(
      codeOf("btc-signature", mapBytes([idField, sigField, keyField, [4, new Uint8Array(0)]]), btcSignatureCodec),
    ).toBe("integrity");
    expect(codeOf("btc-signature", mapBytes([idField, keyField]), btcSignatureCodec)).toBe("integrity");
    expect(codeOf("btc-signature", mapBytes([idField, sigField]), btcSignatureCodec)).toBe("integrity");
    expect(codeOf("btc-signature", mapBytes([sigField, keyField]), btcSignatureCodec)).toBe("no-error");
    // The request id must be 16 bytes under tag 37 — a foreign tag or a bare value is not one.
    expect(
      codeOf(
        "btc-signature",
        mapBytes([[1, taggedValue(Tag.from(37), new Uint8Array(15))], sigField, keyField]),
        btcSignatureCodec,
      ),
    ).toBe("integrity");
    expect(
      codeOf(
        "btc-signature",
        mapBytes([[1, taggedValue(Tag.from(36), REQUEST_ID)], sigField, keyField]),
        btcSignatureCodec,
      ),
    ).toBe("integrity");
    expect(
      codeOf("btc-signature", mapBytes([[1, REQUEST_ID], sigField, keyField]), btcSignatureCodec),
    ).toBe("integrity");
  });

  it("btc-sign-request round-trips and refuses non-message data types", () => {
    const path = {
      components: [{ kind: "index" as const, index: 0, hardened: true }],
      sourceFingerprint: 0xdeadbeef,
    };
    const value = {
      requestId: REQUEST_ID,
      signData: hex("aabb"),
      derivationPaths: [path],
      origin: "qntx",
    };
    const bytes = encodeUr(value, btcSignRequestCodec);
    expect(decodeUr("btc-sign-request", bytes, btcSignRequestCodec)).toStrictEqual(value);
    // dataType 2 is not a message request.
    const tampered = mapBytes([
      [1, taggedValue(Tag.from(37), REQUEST_ID)],
      [2, hex("aabb")],
      [3, 2],
      [4, [keypathTag(path)]],
      [6, "qntx"],
    ]);
    expect(codeOf("btc-sign-request", tampered, btcSignRequestCodec)).toBe("integrity");
  });

  it("qr-hardware-call round-trips and refuses foreign shapes", () => {
    const path = {
      components: [{ kind: "index" as const, index: 44, hardened: true }],
      sourceFingerprint: 0xdeadbeef,
    };
    const value = { schemas: [{ path, curve: "secp256k1" as const }], origin: "qntx" };
    const bytes = encodeUr(value, qrHardwareCallCodec);
    expect(decodeUr("qr-hardware-call", bytes, qrHardwareCallCodec)).toStrictEqual(value);
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
    expect(codeOf("qr-hardware-call", tampered, qrHardwareCallCodec)).toBe("integrity");
  });
});
