/// <reference types="node" />
/**
 * Adds the BIP-39 passphrase vectors without importing kernel code: for the public test mnemonic
 * and a set of passphrases (non-ASCII, decomposed forms, half-width kana, significant spaces) it
 * computes the seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + NFKD(passphrase)) with
 * node:crypto and cross-checks it against @scure/bip39, then the BIP-32 master, walletId, the first
 * EVM address (m/44'/60'/0'/0/0, EIP-55) and the first NIP-06 key (m/44'/1237'/0'/0/0, x-only).
 *
 * Writes the `passphrase` key of vectors/bip39.json (the official `english` vectors stay verbatim)
 * and of vectors/wallet-id.json.
 *
 * Run from the repo root: bun scripts/vectors/passphrase.ts
 */
import { pbkdf2Sync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const PASSPHRASES: ReadonlyArray<{ name: string; passphrase: string }> = [
  { name: "ascii", passphrase: "TREZOR" },
  { name: "composed-accents", passphrase: "p\u00E4ssw\u00F6rd" },
  { name: "decomposed-accents", passphrase: "pa\u0308sswo\u0308rd" },
  { name: "kana-and-compat", passphrase: "\u30AC\uFF76\uFF9E \u2460" },
  { name: "leading-space", passphrase: " a" },
  { name: "no-space", passphrase: "a" },
];

function checksumAddress(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const hex = bytesToHex(keccak_256(uncompressed.slice(1)).slice(12));
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  return `0x${Array.from(hex, (c, i) => (Number.parseInt(hash[i] ?? "0", 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

// oxlint-disable-next-line typescript/no-restricted-types -- @scure/bip32 returns null for a missing key
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("derivation produced no key");
  }
  return value;
}

const entries = PASSPHRASES.map(({ name, passphrase }) => {
  const seed = new Uint8Array(
    pbkdf2Sync(
      MNEMONIC.normalize("NFKD"),
      `mnemonic${passphrase}`.normalize("NFKD"),
      2048,
      64,
      "sha512",
    ),
  );
  if (bytesToHex(seed) !== bytesToHex(mnemonicToSeedSync(MNEMONIC, passphrase))) {
    throw new Error(`seed cross-check failed for ${name}`);
  }
  const master = HDKey.fromMasterSeed(seed);
  const masterPublicKey = must(master.publicKey);
  const evm = master.derive("m/44'/60'/0'/0/0");
  const nostr = master.derive("m/44'/1237'/0'/0/0");
  return {
    name,
    mnemonic: MNEMONIC,
    passphrase,
    seed: bytesToHex(seed),
    masterPublicKey: bytesToHex(masterPublicKey),
    walletId: bytesToHex(
      sha256(concatBytes(utf8ToBytes("qntx-wallet/wallet-id/v1"), masterPublicKey)).slice(0, 8),
    ),
    evmAddress: checksumAddress(must(evm.publicKey)),
    nostrPublicKey: bytesToHex(schnorr.getPublicKey(must(nostr.privateKey))),
  };
});

function update(file: string, key: string, value: unknown): void {
  const path = `vectors/${file}`;
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${path} is not a JSON object`);
  }
  writeFileSync(path, `${JSON.stringify({ ...json, [key]: value }, null, 2)}\n`);
  console.log(`wrote ${path} ${key}`);
}

update(
  "bip39.json",
  "passphrase",
  entries.map(({ name, mnemonic, passphrase, seed, evmAddress, nostrPublicKey }) => ({
    name,
    mnemonic,
    passphrase,
    seed,
    evmAddress,
    nostrPublicKey,
  })),
);
update(
  "wallet-id.json",
  "passphrase",
  entries.map(({ name, mnemonic, passphrase, masterPublicKey, walletId }) => ({
    name,
    mnemonic,
    passphrase,
    masterPublicKey,
    walletId,
  })),
);
