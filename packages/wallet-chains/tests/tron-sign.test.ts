/**
 * `signTronTransaction`/`signTronMessage` reproduce tronweb's signatures byte for byte;
 * recover/verify round-trip the signer; malformed payloads and signatures are refused.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import { signTronMessage, signTronTransaction } from "../src/tron/sign.ts";
import {
  recoverTronMessageSigner,
  recoverTronTransactionSigner,
  verifyTronMessageSignature,
  verifyTronTransactionSignature,
} from "../src/tron/verify.ts";
import { OWNER, tronVectors } from "./tron.ts";

const hex = (h: string): Uint8Array => hexToBytes(h);

const privateKey = tronVectors.keys.find((k) => k.name === "anvil");
if (privateKey === undefined) {
  throw new Error("vectors: no anvil key");
}
const KEY = hex(privateKey.privateKey);

describe("signTronTransaction", () => {
  it.each(tronVectors.transactions)(
    "$name: reproduces tronweb's signature byte for byte",
    (vector) => {
      const signature = signTronTransaction(hex(vector.rawDataHex), KEY);
      expect(bytesToHex(signature)).toBe(vector.signature.toLowerCase());
    },
  );

  it("refuses a bare 32-byte digest and malformed raw_data", () => {
    expect(() => signTronTransaction(new Uint8Array(32), KEY)).toThrow(
      /a bare 32-byte digest is not a TRON transaction/,
    );
    expect(() => signTronTransaction(new Uint8Array(64).fill(0xaa), KEY)).toThrow(ChainError);
  });

  it("refuses 31- and 33-byte keys", () => {
    const rawData = hex(tronVectors.transactions[0]!.rawDataHex);
    expect(() => signTronTransaction(rawData, new Uint8Array(31))).toThrow(ChainError);
    expect(() => signTronTransaction(rawData, new Uint8Array(33))).toThrow(ChainError);
  });
});

describe("signTronMessage", () => {
  it.each(tronVectors.messages)("$name: reproduces tronweb's signature", (vector) => {
    const signature = signTronMessage(hex(vector.messageHex), hex(vector.privateKey));
    expect(bytesToHex(signature)).toBe(vector.signature.toLowerCase());
    expect(recoverTronMessageSigner(hex(vector.messageHex), signature)).toBe(vector.address);
    expect(verifyTronMessageSignature(hex(vector.messageHex), signature, vector.address)).toBe(
      true,
    );
  });

  it("refuses an empty message and a bad key", () => {
    expect(() => signTronMessage(new Uint8Array(0), KEY)).toThrow(ChainError);
    expect(() => signTronMessage(new Uint8Array(4), new Uint8Array(16))).toThrow(ChainError);
  });
});

describe("recover and verify", () => {
  const rawData = hex(tronVectors.transactions[0]!.rawDataHex);
  const signature = hex(tronVectors.transactions[0]!.signature);

  it("recovers the transaction signer and verifies", () => {
    expect(recoverTronTransactionSigner(rawData, signature)).toBe(OWNER);
    expect(verifyTronTransactionSignature(rawData, signature, OWNER)).toBe(true);
  });

  it("verify is false for a flipped raw_data bit and a wrong address", () => {
    const flipped = new Uint8Array(rawData);
    flipped.set([rawData[0]! + 1], 0);
    expect(verifyTronTransactionSignature(flipped, signature, OWNER)).toBe(false);
    expect(
      verifyTronTransactionSignature(rawData, signature, "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"),
    ).toBe(false);
  });

  it("verify is false for v=29, v=0, and a 64-byte signature", () => {
    const v29 = new Uint8Array(signature);
    v29[64] = 29;
    expect(verifyTronTransactionSignature(rawData, v29, OWNER)).toBe(false);
    const v0 = new Uint8Array(signature);
    v0[64] = 0;
    expect(verifyTronTransactionSignature(rawData, v0, OWNER)).toBe(false);
    expect(verifyTronTransactionSignature(rawData, signature.subarray(0, 64), OWNER)).toBe(false);
    expect(() => recoverTronTransactionSigner(rawData, v29)).toThrow(ChainError);
    expect(() => recoverTronTransactionSigner(rawData, v0)).toThrow(ChainError);
    expect(() => recoverTronTransactionSigner(rawData, signature.subarray(0, 64))).toThrow(
      ChainError,
    );
  });
});
