import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { masterKey } from "../src/derive/hd.ts";
import { nostrKeyAt } from "../src/modules/nostr/derive.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { kernelError, loadVectors, subtlePbkdf2 } from "./helpers.ts";

type Nip06Vector = {
  mnemonic: string;
  privateKey: string;
  publicKey: string;
  nsec: string;
  npub: string;
};
const { vectors } = loadVectors("nip06.json") as { vectors: Nip06Vector[] };

describe("NIP-06 vectors", () => {
  it.each(vectors)("identity-0 key for $mnemonic", async (vector) => {
    const seed = await seedFromEntropy(entropyFromMnemonic(vector.mnemonic), "", subtlePbkdf2);
    const master = masterKey(seed);
    const privateKey = nostrKeyAt(master, 0);
    expect(bytesToHex(privateKey)).toBe(vector.privateKey);
    expect(bytesToHex(schnorr.getPublicKey(privateKey))).toBe(vector.publicKey);
    expect(bech32.encode("nsec", bech32.toWords(privateKey))).toBe(vector.nsec);
    expect(bech32.encode("npub", bech32.toWords(schnorr.getPublicKey(privateKey)))).toBe(
      vector.npub,
    );
    master.wipePrivateData();
  });
});

describe("identity indices", () => {
  it("identity 1 on a single-account-group wallet differs from identity 0", async () => {
    // One wallet, one account group: identity indices 0 and 1 each derive the NIP-06
    // key at m/44'/1237'/i'/0/0 — no account group is consulted or created.
    const seed = await seedFromEntropy(entropyFromMnemonic(vectors[0]!.mnemonic), "", subtlePbkdf2);
    const master = masterKey(seed);
    const identity0 = nostrKeyAt(master, 0);
    const identity1 = nostrKeyAt(master, 1);
    expect(bytesToHex(schnorr.getPublicKey(identity0))).toBe(vectors[0]!.publicKey);
    expect(identity1).not.toStrictEqual(identity0);
    expect(identity1).toHaveLength(32);
    master.wipePrivateData();
  });
});

describe("nostrKeyAt identity index bounds", () => {
  it("rejects non-integer and out-of-range indexes", async () => {
    const seed = await seedFromEntropy(entropyFromMnemonic(vectors[0]!.mnemonic), "", subtlePbkdf2);
    const master = masterKey(seed);
    for (const index of [-1, 2 ** 31, 0.5, Number.NaN]) {
      expect(kernelError(() => nostrKeyAt(master, index))).toBe("invalid-input");
    }
    expect(nostrKeyAt(master, 2 ** 31 - 1)).not.toStrictEqual(nostrKeyAt(master, 0));
    master.wipePrivateData();
  });
});
