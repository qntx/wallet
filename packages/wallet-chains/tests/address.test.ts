/** Public account-derivation helpers against vectors/templates/chains.json. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinAddressFromXpub } from "../src/bitcoin/account.ts";
import { evmAddressFromPublicKey } from "../src/evm/address.ts";
import { solanaAddressFromPublicKey } from "../src/solana/ids.ts";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/templates/chains.json"), "utf8"),
) as {
  mnemonic: string;
  evm: {
    template: string;
    network: string;
    accounts: Array<{ groupIndex: number; address: string }>;
  };
  solana: { accounts: Array<{ address: string }> };
  bitcoin: Array<{ template: string; network: string; xpub: string; receive: string[] }>;
};

/** Verified SLIP-10 ed25519 derivation — same helper as solana.test.ts. */
const slip10 = (seed: Uint8Array, path: ReadonlyArray<number>): Uint8Array => {
  let hmacOut = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let chain = hmacOut.slice(32);
  let node = hmacOut.slice(0, 32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data.set(node, 1);
    const idx = index + 0x80000000;
    data[33] = Math.floor(idx / 16777216);
    data[34] = Math.floor(idx / 65536) % 256;
    data[35] = Math.floor(idx / 256) % 256;
    data[36] = idx % 256;
    hmacOut = hmac(sha512, chain, data);
    chain = hmacOut.slice(32);
    node = hmacOut.slice(0, 32);
  }
  return node;
};

describe("address derivation helpers", () => {
  const seed = mnemonicToSeedSync(vectors.mnemonic);

  it("evmAddressFromPublicKey matches the vector accounts", () => {
    const master = HDKey.fromMasterSeed(seed);
    for (const { groupIndex, address } of vectors.evm.accounts) {
      const pub = master.derive(`m/44'/60'/0'/0/${groupIndex}`).publicKey;
      expect(pub).not.toBeNull();
      expect(evmAddressFromPublicKey(pub!)).toBe(address);
    }
  });

  it("accepts an uncompressed 65-byte key", () => {
    const compressed = secp256k1.getPublicKey(new Uint8Array(32).fill(7), true);
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    expect(evmAddressFromPublicKey(uncompressed)).toBe(evmAddressFromPublicKey(compressed));
  });

  it("solanaAddressFromPublicKey matches the vector accounts", () => {
    for (const [i, { address }] of vectors.solana.accounts.entries()) {
      const priv = slip10(seed, [44, 501, i, 0]);
      expect(solanaAddressFromPublicKey(ed25519.getPublicKey(priv))).toBe(address);
    }
  });

  it("bitcoinAddressFromXpub matches the BIP-84/86 receive addresses", () => {
    for (const { xpub, template, network, receive } of vectors.bitcoin) {
      for (const [i, address] of receive.entries()) {
        expect(
          bitcoinAddressFromXpub(xpub, template as "btc.bip84" | "btc.bip86", network, 0, i),
        ).toBe(address);
      }
    }
  });
});
