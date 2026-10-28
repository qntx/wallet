/// <reference types="node" />
/**
 * Regenerates vectors/backup.json with fixed byte constants — no kernel imports. Layout
 * (design/backup.mdx + wallet-spark.mdx E1-d-3b):
 *
 * Payload = version(0x01) ‖ walletEntry…, walletEntry = 0x01 ‖ origin(1) ‖ len(1) ‖ entropy
 * sealed(X) = 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, aad).encrypt(plaintext) aad = 0x01
 * ‖ u16be(len(UTF-8(context))) ‖ UTF-8(context) ‖ UTF-8(header) payload.context =
 * "qntx-wallet/backup/v1/payload/" + hex(SHA-256(headerText)) factor.context =
 * "qntx-wallet/backup/v1/factor/" + kind password KEK = PBKDF2-HMAC-SHA256(NFKC(password), salt16,
 * 600000, 32) passkey KEK = HKDF-SHA256(prfBackup, salt=credentialId,
 * info="qntx-wallet/kek/backup/v1") backup-key id = hex(HKDF-SHA256(BEK, salt=empty,
 * info="qntx-wallet/backup/v1/id", 16)) backup-key header text = {"id","factors","createdAt"} in
 * that key order passkey wallet : entropy = prfWallet[0..16), origin byte 0x02
 *
 * `backup.enable` draws deterministically: BEK, every password salt in factor order, every
 * sealedBek nonce in factor order — no draw follows an await — then the `backup-key` record's seal
 * nonce. `backup.update` draws exactly once: the payload seal nonce. The kernel-side test replays
 * `draws` through the injected random source; the enable-time factors and id plus each update
 * envelope must match byte for byte.
 *
 * Run from the repo root: bun scripts/vectors/backup.ts
 */
import { writeFileSync } from "node:fs";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const CREDENTIAL_ID = utf8ToBytes("backup-vector-credential");
const PRF_VAULT = hexToBytes("11".repeat(32));
const PRF_WALLET = hexToBytes("22".repeat(32));
const PRF_BACKUP = hexToBytes("33".repeat(32));
const PASSWORD = "backup vector password";
const START = 1_700_000_000_000;

// walletId = hex(SHA-256("qntx-wallet/wallet-id/v1" ‖ master.compressedPublicKey)[0..8)) —
// the same independent derivation as vectors/wallet-id.json.
function walletIdOfEntropy(entropy: Uint8Array): string {
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const seed = pbkdf2(
    sha512,
    new TextEncoder().encode(mnemonic.normalize("NFKD")),
    new TextEncoder().encode("mnemonic".normalize("NFKD")),
    { c: 2048, dkLen: 64 },
  );
  const { publicKey } = HDKey.fromMasterSeed(seed);
  if (publicKey === null) {
    throw new Error("master key has no public key");
  }
  return bytesToHex(
    sha256(concatBytes(utf8ToBytes("qntx-wallet/wallet-id/v1"), publicKey)).slice(0, 8),
  );
}

/**
 * Every `platform.random` call the kernel makes through `wallet.createWithPasskey`,
 * `backup.enable`, and two `backup.update` calls, in order. The wallet-create draws are fixed
 * filler; the backup draws below drive every byte the assertions pin.
 */
const DRAWS: ReadonlyArray<readonly [string, string]> = [
  ["01".repeat(32), "vault DEK"],
  ["02".repeat(24), "vault factor wrap nonce"],
  ["03".repeat(16), "session id"],
  ["04".repeat(32), "nostr data-key DEK"],
  ["05".repeat(24), "entropy record seal nonce"],
  ["06".repeat(16), "nostr record id"],
  ["07".repeat(16), "session id (second)"],
  ["11".repeat(32), "enable: BEK"],
  ["12".repeat(16), "enable: password salt"],
  ["13".repeat(24), "enable: password sealedBek nonce"],
  ["14".repeat(24), "enable: passkey sealedBek nonce"],
  ["15".repeat(24), "enable: backup-key record seal nonce"],
  ["16".repeat(24), "update #1: payload nonce"],
  ["17".repeat(24), "update #2: payload nonce"],
];

function draw(index: number): Uint8Array {
  const entry = DRAWS[index];
  if (entry === undefined) {
    throw new Error(`draw ${index} missing`);
  }
  return hexToBytes(entry[0]);
}

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

function seal(
  key: Uint8Array,
  nonce: Uint8Array,
  context: string,
  plaintext: Uint8Array,
): Uint8Array {
  return concatBytes(
    new Uint8Array([0x01]),
    nonce,
    xchacha20poly1305(key, nonce, aad(context, "")).encrypt(plaintext),
  );
}

const entropy = PRF_WALLET.slice(0, 16);
const walletId = walletIdOfEntropy(entropy);

const bek = draw(7);
const passwordSalt = draw(8);
const passwordNonce = draw(9);
const passkeyNonce = draw(10);
const payloadNonce1 = draw(12);
const payloadNonce2 = draw(13);

const id = bytesToHex(
  hkdf(sha256, bek, new Uint8Array(0), utf8ToBytes("qntx-wallet/backup/v1/id"), 16),
);

const passwordKek = pbkdf2(
  sha256,
  new TextEncoder().encode(PASSWORD.normalize("NFKC")),
  passwordSalt,
  { c: 600_000, dkLen: 32 },
);
const passwordSealedBek = seal(
  passwordKek,
  passwordNonce,
  "qntx-wallet/backup/v1/factor/password",
  bek,
);
const passkeyKek = hkdf(
  sha256,
  PRF_BACKUP,
  CREDENTIAL_ID,
  utf8ToBytes("qntx-wallet/kek/backup/v1"),
  32,
);
const passkeySealedBek = seal(
  passkeyKek,
  passkeyNonce,
  "qntx-wallet/backup/v1/factor/passkey",
  bek,
);

const factors = [
  {
    kind: "password",
    iterations: 600_000,
    salt: base64urlnopad.encode(passwordSalt),
    sealedBek: base64urlnopad.encode(passwordSealedBek),
  },
  {
    kind: "passkey",
    credentialId: base64urlnopad.encode(CREDENTIAL_ID),
    sealedBek: base64urlnopad.encode(passkeySealedBek),
  },
];

const backupKeyHeader = JSON.stringify({ id, factors, createdAt: START });

const header = JSON.stringify({
  wallets: [{ walletId, origin: "passkey", words: 12 }],
  importedNostrKeyCount: 0,
  importedChainKeyCount: 0,
});
const payload = concatBytes(new Uint8Array([0x01, 0x01, 0x02, 16]), entropy);
const payloadContext = `qntx-wallet/backup/v1/payload/${bytesToHex(sha256(utf8ToBytes(header)))}`;

const envelopeOf = (nonce: Uint8Array): string =>
  JSON.stringify({
    version: 1,
    createdAt: START,
    header,
    factors,
    payload: base64urlnopad.encode(seal(bek, nonce, payloadContext, payload)),
  });

const envelopes = [envelopeOf(payloadNonce1), envelopeOf(payloadNonce2)];

const vector = {
  comment:
    "Fixed-input backup vector generated by scripts/vectors/backup.ts (independent of the " +
    "kernel). `draws` replay through the kernel's injected random source; the enable-time " +
    "backup-key id/factors and both update envelopes must match byte for byte — the second " +
    "envelope differs only in the payload nonce, proving the factor entries are copied verbatim.",
  inputs: {
    credentialIdHex: bytesToHex(CREDENTIAL_ID),
    prfVault: bytesToHex(PRF_VAULT),
    prfWallet: bytesToHex(PRF_WALLET),
    prfBackup: bytesToHex(PRF_BACKUP),
    password: PASSWORD,
    start: START,
  },
  draws: DRAWS.map(([bytes, site]) => ({ length: hexToBytes(bytes).length, bytes, site })),
  walletId,
  id,
  backupKeyHeader,
  enable: { factors },
  envelopes,
};

writeFileSync("vectors/backup.json", `${JSON.stringify(vector, null, 2)}\n`);
console.log(
  `vectors/backup.json: id ${id}, envelopes ${envelopes.map((e) => e.length).join("/")} chars, ${DRAWS.length} draws`,
);
