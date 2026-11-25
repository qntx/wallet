// oxlint-disable vitest/expect-expect -- assertions live in the integrity/code helpers
/**
 * The driver's UR decode edge: every malformed or hostile device answer — truncated or non-shortest
 * heads, indefinite containers, duplicate or misordered map keys, trailing bytes, hostile nesting,
 * invalid or non-canonical UTF-8, oversized input, random garbage — ends in a typed
 * `KernelError("integrity")`, never an untyped error. The decoders are `@qntx/ur`'s dCBOR codecs
 * behind `decodeUr`; these cases run through the sync answer entry (`parseSync`) and the
 * signature/psbt codecs exactly as the sign exchange calls them.
 */
import { CborMap, Tag, encodeCbor, taggedValue } from "@blockchaincommons/dcbor";
import type { CborInput } from "@blockchaincommons/dcbor";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  btcSignatureCodec,
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
import { decodeUr } from "../src/modules/signers/keystone/ur.ts";

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
    // A structurally valid btc-signature map read as an eth-signature: eth's key 3 is the text
    // origin, so the byte-string public key is the wrong type; as btc-signature it decodes.
    const signature = hex(
      `a301d8255000112233445566778899aabbccddeeff025841${"aa".repeat(65)}03582102${"bb".repeat(
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

describe("btc-signature request ids", () => {
  // The codec's wire cases are `@qntx/ur`'s vectors; these pin the request-id admission the sign
  // exchange's wrong-device check relies on: a 16-byte uuid under tag 37, never absent.
  const REQUEST_ID = hex("00112233445566778899aabbccddeeff");
  const answer = (id: CborInput | undefined): Uint8Array =>
    encodeCbor(
      new CborMap(
        new Map<number, CborInput>([
          ...(id === undefined ? [] : [[1, id] as const]),
          [2, new Uint8Array(65).fill(7)],
          [3, new Uint8Array(33).fill(9)],
        ]),
      ),
    );
  const codeOf = (bytes: Uint8Array): string =>
    code(() => decodeUr("btc-signature", bytes, btcSignatureCodec));

  it("admits only a tagged 16-byte uuid", () => {
    expect(codeOf(answer(taggedValue(Tag.from(37), REQUEST_ID)))).toBe("no-error");
    expect(codeOf(answer(undefined))).toBe("integrity");
    expect(codeOf(answer(taggedValue(Tag.from(37), new Uint8Array(15))))).toBe("integrity");
    expect(codeOf(answer(taggedValue(Tag.from(36), REQUEST_ID)))).toBe("integrity");
    expect(codeOf(answer(REQUEST_ID))).toBe("integrity");
  });
});
