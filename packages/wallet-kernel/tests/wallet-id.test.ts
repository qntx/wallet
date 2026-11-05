import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { masterKey } from "../src/derive/hd.ts";
import { walletIdOf } from "../src/derive/wallet-id.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { loadVectors, subtlePbkdf2 } from "./helpers.ts";

type WalletIdVector = { seed: string; masterPublicKey: string; walletId: string };
const { vectors } = loadVectors("wallet-id.json") as { vectors: WalletIdVector[] };

describe("walletId", () => {
  it.each(vectors)("$seed → $walletId", (vector) => {
    const master = masterKey(hexToBytes(vector.seed));
    expect(bytesToHex(master.publicKey!)).toBe(vector.masterPublicKey);
    expect(walletIdOf(master)).toBe(vector.walletId);
    master.wipePrivateData();
  });
});

type PassphraseWalletId = {
  name: string;
  mnemonic: string;
  passphrase: string;
  masterPublicKey: string;
  walletId: string;
};
const { passphrase: passphraseVectors } = loadVectors("wallet-id.json") as {
  passphrase: PassphraseWalletId[];
};

describe("walletId with a passphrase", () => {
  it.each(passphraseVectors)("$name → $walletId", async (vector) => {
    const seed = await seedFromEntropy(
      entropyFromMnemonic(vector.mnemonic),
      vector.passphrase,
      subtlePbkdf2,
    );
    const master = masterKey(seed);
    expect(bytesToHex(master.publicKey!)).toBe(vector.masterPublicKey);
    expect(walletIdOf(master)).toBe(vector.walletId);
    master.wipePrivateData();
  });
});
