/** TRON address helpers against vectors/chains/tron.json (tronweb 6.5.2 oracle). */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import {
  isTronAddress,
  tronAddressFromBytes,
  tronAddressFromEvm,
  tronAddressFromHex,
  tronAddressFromPublicKey,
  tronAddressToBytes,
  tronAddressToEvm,
  tronAddressToHex,
} from "../src/tron/index.ts";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/tron.json"), "utf8"),
) as {
  derivation: Array<{
    mnemonic: string;
    index: number;
    path: string;
    privateKey: string;
    address: string;
  }>;
  keys: Array<{ name: string; privateKey: string; address: string }>;
  invalid: Array<{ value: string; reason: string }>;
};

describe("tronAddressFromPublicKey", () => {
  it("reproduces every derivation row's address and private key", () => {
    for (const row of vectors.derivation) {
      const child = HDKey.fromMasterSeed(mnemonicToSeedSync(row.mnemonic)).derive(row.path);
      expect(child.privateKey).not.toBeNull();
      expect(child.publicKey).not.toBeNull();
      expect(hexToBytes(row.privateKey)).toStrictEqual(child.privateKey!);
      expect(tronAddressFromPublicKey(child.publicKey!)).toBe(row.address);
      child.wipePrivateData();
    }
  });

  it("reproduces every key row's address", () => {
    for (const { privateKey, address } of vectors.keys) {
      expect(tronAddressFromPublicKey(secp256k1.getPublicKey(hexToBytes(privateKey), true))).toBe(
        address,
      );
    }
  });

  it("accepts an uncompressed 65-byte key and rejects other lengths", () => {
    const compressed = secp256k1.getPublicKey(hexToBytes(vectors.keys[0]!.privateKey), true);
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    expect(tronAddressFromPublicKey(uncompressed)).toBe(vectors.keys[0]!.address);
    expect(() => tronAddressFromPublicKey(uncompressed.slice(0, 64))).toThrow(ChainError);
    expect(() => tronAddressFromPublicKey(new Uint8Array(32))).toThrow(ChainError);
  });
});

describe("isTronAddress", () => {
  it("accepts every valid vector address", () => {
    for (const { address } of [...vectors.derivation, ...vectors.keys]) {
      expect(isTronAddress(address)).toBe(true);
    }
  });

  it.each(vectors.invalid)("rejects $value ($reason)", ({ value }) => {
    expect(isTronAddress(value)).toBe(false);
    expect(() => tronAddressToBytes(value)).toThrow(ChainError);
  });
});

describe("tron address encodings", () => {
  const { address } = vectors.keys[0]!;

  it("round-trips base58, hex and EVM forms", () => {
    expect(tronAddressFromBytes(tronAddressToBytes(address))).toBe(address);
    const hex = tronAddressToHex(address);
    expect(hex).toMatch(/^41[0-9a-f]{40}$/);
    expect(tronAddressFromHex(hex)).toBe(address);
    const evm = tronAddressToEvm(address);
    expect(evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(tronAddressFromEvm(evm)).toBe(address);
  });

  it("rejects malformed byte and hex forms", () => {
    const bytes = tronAddressToBytes(address);
    expect(() => tronAddressFromBytes(bytes.slice(0, 20))).toThrow(ChainError);
    expect(() => tronAddressFromBytes(Uint8Array.of(...bytes, 0))).toThrow(ChainError);
    const wrongPrefix = Uint8Array.of(0x42, ...bytes.slice(1));
    expect(() => tronAddressFromBytes(wrongPrefix)).toThrow(ChainError);
    expect(() => tronAddressFromHex(tronAddressToHex(address).slice(0, -1))).toThrow(ChainError);
    expect(() => tronAddressFromHex(`42${tronAddressToHex(address).slice(2)}`)).toThrow(ChainError);
    expect(() => tronAddressFromEvm(tronAddressToEvm(address).slice(0, -1))).toThrow(ChainError);
    expect(() => tronAddressFromEvm("0x")).toThrow(ChainError);
  });

  it("round-trips random 20-byte bodies through bytes, hex and EVM forms", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (body) => {
        const encoded = tronAddressFromBytes(Uint8Array.of(0x41, ...body));
        expect(isTronAddress(encoded)).toBe(true);
        expect(tronAddressToBytes(encoded)).toStrictEqual(Uint8Array.of(0x41, ...body));
        expect(tronAddressFromHex(tronAddressToHex(encoded))).toBe(encoded);
        expect(tronAddressFromEvm(tronAddressToEvm(encoded))).toBe(encoded);
      }),
    );
  });

  it("isTronAddress returns a boolean on arbitrary strings without throwing", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (value) => {
        expect(isTronAddress(value)).toBeTypeOf("boolean");
      }),
    );
  });
});
