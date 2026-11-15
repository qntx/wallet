/**
 * Regenerates vectors/vault-v013.json without importing kernel code: a format-3 vault image spelled
 * out byte by byte exactly as v0.13 wrote it on React Native — noble only.
 *
 * The image holds one `hardware` factor (the only keystore kind v0.13 knew), the `entropy` record
 * of the public test mnemonic "abandon ×11 about", and the `nostr-key` record of its identity 0
 * (NIP-06 m/44'/1237'/0'/0/0). The fake keystore of the kernel tests seals with
 * SHA-256(utf8(keyId)), so `sealedKek` is exactly that — unlocking this image with that fake
 * keystore opens the vault for real.
 *
 * Layout (kernel store format): meta = { format: 3, revision, keyId, failedAttempts, lastFailureAt
 * } factor = { kind: "hardware", id, header: {"sealedKek","publicKey","createdAt"}, sealed } record
 * = { kind, id, header, sealed } sealed = envelopeV1: 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(DEK,
 * plaintext) aad = 0x01 ‖ u16be(len(ctx)) ‖ UTF-8(ctx) ‖ UTF-8(header) record context =
 * "qntx-wallet/vault/v1/record/" ‖ kind ‖ "/" ‖ id factor wrap v2 = see
 * scripts/vectors/factor-wrap.ts (same construction)
 *
 * Run from the repo root: bun scripts/vectors/vault-v013.ts
 */
import { writeFileSync } from "node:fs";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToEntropy, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CREATED_AT = 1767225600000;
const KEY_ID = "3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c";

const DEK = hexToBytes("0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0");
const FACTOR_ID = "aabbccddeeff00112233445566778899";
const KEK = hexToBytes("d43390937c8e83be3b33e1fb9596ddf65cec5880a09786837bde9847aadba95e");

const FACTOR_KEY_INFO = utf8ToBytes("qntx-wallet/vault/v2/factor-key");
const WRAP_INFO = utf8ToBytes("qntx-wallet/vault/v2/wrap");
const BINDING_TAG = utf8ToBytes("qntx-wallet/vault/v2/binding");

function aad(context: string, header: string): Uint8Array {
  const c = utf8ToBytes(context);
  const h = utf8ToBytes(header);
  const out = new Uint8Array(3 + c.length + h.length);
  out[0] = 0x01;
  new DataView(out.buffer).setUint16(1, c.length);
  out.set(c, 3);
  out.set(h, 3 + c.length);
  return out;
}

function sealRecord(plaintext: Uint8Array, context: string, header: string, nonce: Uint8Array) {
  return concatBytes(
    new Uint8Array([0x01]),
    nonce,
    xchacha20poly1305(DEK, nonce, aad(context, header)).encrypt(plaintext),
  );
}

function wrapDek(factorPk: Uint8Array, kind: string, id: string, header: string) {
  const eph = hexToBytes("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f");
  const nonce = hexToBytes("c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7");
  const ephPk = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, factorPk);
  const wrapKey = hkdf(sha256, shared, concatBytes(ephPk, factorPk), WRAP_INFO, 32);
  const context = `qntx-wallet/vault/v1/factor/${kind}/${id}`;
  const envelope = concatBytes(
    new Uint8Array([0x01]),
    nonce,
    xchacha20poly1305(wrapKey, nonce, aad(context, header)).encrypt(DEK),
  );
  const binding = hmac(sha256, DEK, concatBytes(BINDING_TAG, aad(context, header)));
  return bytesToHex(concatBytes(new Uint8Array([0x02]), ephPk, binding, envelope));
}

// Wallet identity: BIP-39 seed → BIP-32 master → the public wallet id; NIP-06 identity 0.
const seed = mnemonicToSeedSync(MNEMONIC);
const master = HDKey.fromMasterSeed(seed);
if (master.publicKey === null) {
  throw new Error("master key has no public key");
}
const walletId = bytesToHex(
  sha256(concatBytes(utf8ToBytes("qntx-wallet/wallet-id/v1"), master.publicKey)).slice(0, 8),
);
const nostrNode = master.derive("m/44'/1237'/0'/0/0");
if (nostrNode.privateKey === null) {
  throw new Error("nostr node has no private key");
}
const nostrSecretKey = nostrNode.privateKey;
const nostrPublicKey = bytesToHex(schnorr.getPublicKey(nostrSecretKey));

const entropy = mnemonicToEntropy(MNEMONIC, wordlist);

const factorSk = hkdf(sha256, KEK, new Uint8Array(0), FACTOR_KEY_INFO, 32);
const factorPk = x25519.getPublicKey(factorSk);
const factorHeader = JSON.stringify({
  sealedKek: base64urlnopad.encode(sha256(utf8ToBytes(FACTOR_ID))),
  publicKey: base64urlnopad.encode(factorPk),
  createdAt: CREATED_AT,
});

const entropyHeader = JSON.stringify({
  walletId,
  origin: "mnemonic",
  words: 12,
  backup: "none",
  createdAt: CREATED_AT,
});
const nostrHeader = JSON.stringify({
  publicKey: nostrPublicKey,
  walletId,
  index: 0,
  createdAt: CREATED_AT,
});

const image = {
  meta: { format: 3, revision: 3, keyId: KEY_ID, failedAttempts: 0, lastFailureAt: 0 },
  factors: [
    {
      kind: "hardware",
      id: FACTOR_ID,
      header: factorHeader,
      sealed: wrapDek(factorPk, "hardware", FACTOR_ID, factorHeader),
    },
  ],
  records: [
    {
      kind: "entropy",
      id: walletId,
      header: entropyHeader,
      sealed: bytesToHex(
        sealRecord(
          entropy,
          `qntx-wallet/vault/v1/record/entropy/${walletId}`,
          entropyHeader,
          hexToBytes("0102030405060708090a0b0c0d0e0f101112131415161718"),
        ),
      ),
    },
    {
      kind: "nostr-key",
      id: nostrPublicKey,
      header: nostrHeader,
      sealed: bytesToHex(
        sealRecord(
          nostrSecretKey,
          `qntx-wallet/vault/v1/record/nostr-key/${nostrPublicKey}`,
          nostrHeader,
          hexToBytes("2122232425262728292a2b2c2d2e2f303132333435363738"),
        ),
      ),
    },
  ],
};

const out = {
  comment: [
    "TEST ONLY — fixed keys, never usable material. A format-3 vault image as v0.13 wrote it on",
    "React Native: one hardware factor, the public test mnemonic's entropy record, its NIP-06",
    "identity-0 nostr-key record. sealedKek is sha256(utf8(factorId)) — the kernel tests' fake",
    "keystore convention — so that fake opens this image for real. Generated by",
    "scripts/vectors/vault-v013.ts (noble only, independent of the kernel).",
  ].join(" "),
  dek: bytesToHex(DEK),
  kek: bytesToHex(KEK),
  factorId: FACTOR_ID,
  walletId,
  nostrPublicKey,
  image,
};

writeFileSync("vectors/vault-v013.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote vectors/vault-v013.json");
