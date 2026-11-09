// vectors/key-id.json replays through derive/key-id.ts: keyId = hex(first 8 bytes of
// SHA-256("qntx-wallet/key-id/v1" ‖ familyByte ‖ publicKey)).

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { KEY_FAMILY_BYTE, keyIdOf } from "../src/derive/key-id.ts";
import { loadVectors } from "./helpers.ts";

type Vector = {
  readonly name: string;
  readonly family: "evm" | "solana" | "bitcoin";
  readonly familyByte: number;
  readonly publicKey: string;
  readonly keyId: string;
};
const { vectors } = loadVectors("key-id.json") as { vectors: Vector[] };

describe("keyId derivation vectors", () => {
  it.each(vectors)("$name reproduces the keyId", (vector) => {
    expect(KEY_FAMILY_BYTE[vector.family]).toBe(vector.familyByte);
    expect(keyIdOf(vector.family, hexToBytes(vector.publicKey))).toBe(vector.keyId);
  });

  it("the same public key on two families gives different keyIds", () => {
    const solana = vectors.find((v) => v.name === "solana-slip10-master");
    const bitcoin = vectors.find((v) => v.name === "bitcoin-same-pub");
    expect(solana?.publicKey).toBe(bitcoin?.publicKey);
    expect(solana?.keyId).not.toBe(bitcoin?.keyId);
  });
});
