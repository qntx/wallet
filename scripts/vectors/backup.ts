/// <reference types="node" />
/**
 * Regenerates vectors/backup.json with fixed byte constants — no kernel imports. The backup
 * envelope is composed here from the documented layout:
 *
 * Payload = version(0x01) ‖ walletEntry…, walletEntry = 0x01 ‖ origin(1) ‖ len(1) ‖ entropy
 * sealed(X) = 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, aad).encrypt(plaintext) aad = 0x01
 * ‖ u16be(len(UTF-8(context))) ‖ UTF-8(context) ‖ UTF-8(header) payload.context =
 * "qntx-wallet/backup/v1/payload/" + hex(SHA-256(headerText)) factor.context =
 * "qntx-wallet/backup/v1/factor/" + kind password KEK = PBKDF2-HMAC-SHA256(NFKC(password), salt16,
 * 600000, 32) passkey KEK = HKDF-SHA256(prfBackup, salt=credentialId,
 * info="qntx-wallet/kek/backup/v1") passkey wallet : entropy = prfWallet[0..16), origin byte 0x02
 *
 * The kernel-side test replays `draws` through the injected random source and must reproduce
 * `envelope` byte for byte — draws the kernel makes outside backup.create are fixed filler. Run
 * from the repo root: bun scripts/vectors/backup.ts
 */
import { writeFileSync } from "node:fs";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { pbkdf2, pbkdf2 as pbkdf2_512 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const CREDENTIAL_ID = utf8ToBytes("backup-vector-credential");
const PRF_VAULT = hexToBytes("01".repeat(32));
const PRF_WALLET = hexToBytes("22".repeat(32));
const PRF_BACKUP = hexToBytes("33".repeat(32));
const PASSWORD = "backup vector password";
const START = 1_700_000_000_000;

// walletId = hex(SHA-256("qntx-wallet/wallet-id/v1" ‖ master.compressedPublicKey)[0..8)) —
// the same independent derivation as vectors/wallet-id.json.
function walletIdOfEntropy(entropy: Uint8Array): string {
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const seed = pbkdf2_512(
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
 * Every `platform.random` call the kernel makes while a test runs `wallet.createWithPasskey` +
 * `backup.create`, in order: DEK, factor-wrap and record-seal nonces, session ids, then the backup
 * draws — BEK, payload nonce, password salt, password sealedBek nonce, passkey sealedBek nonce.
 */
const DRAWS = [
  "01".repeat(32), // vault DEK
  "02".repeat(24), // vault factor wrap nonce
  "03".repeat(16), // session id
  "04".repeat(32), // nostr data key DEK
  "05".repeat(24), // entropy record seal nonce
  "06".repeat(16), // nostr record id
  "07".repeat(16), // session id (second)
  "11".repeat(32), // backup: BEK
  "12".repeat(24), // backup: payload nonce
  "13".repeat(16), // backup: password salt
  "14".repeat(24), // backup: password sealedBek nonce
  "15".repeat(24), // backup: passkey sealedBek nonce
];

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

function seal(key: Uint8Array, nonce: Uint8Array, context: string, plaintext: Uint8Array) {
  return concatBytes(
    new Uint8Array([0x01]),
    nonce,
    xchacha20poly1305(key, nonce, aad(context, "")).encrypt(plaintext),
  );
}

const entropy = PRF_WALLET.slice(0, 16);
const walletId = walletIdOfEntropy(entropy);
const header = JSON.stringify({
  wallets: [{ walletId, origin: "passkey", words: 12 }],
  importedNostrKeyCount: 0,
  importedChainKeyCount: 0,
});

function draw(index: number): Uint8Array {
  const bytes = DRAWS[index];
  if (bytes === undefined) {
    throw new Error(`draw ${index} missing`);
  }
  return hexToBytes(bytes);
}

const bek = draw(7);
const payloadNonce = draw(8);
const passwordSalt = draw(9);
// backup.create draws deterministically: BEK, payload nonce, password salts in factor order,
// then sealedBek nonces in factor order — no draw follows an await.
const passwordNonce = draw(10);
const passkeyNonce = draw(11);

const payload = concatBytes(new Uint8Array([0x01, 0x01, 0x02, 16]), entropy);
const sealedPayload = seal(
  bek,
  payloadNonce,
  `qntx-wallet/backup/v1/payload/${bytesToHex(sha256(utf8ToBytes(header)))}`,
  payload,
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

const envelope = JSON.stringify({
  version: 1,
  createdAt: START,
  header,
  factors: [
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
  ],
  payload: base64urlnopad.encode(sealedPayload),
});

const vector = {
  comment:
    "Fixed-input backup-envelope vector generated by scripts/vectors/backup.ts (independent of " +
    "the kernel). `draws` replay through the kernel's injected random source; the rebuilt " +
    "envelope must equal `envelope` byte for byte.",
  inputs: {
    credentialIdHex: bytesToHex(CREDENTIAL_ID),
    prfVault: bytesToHex(PRF_VAULT),
    prfWallet: bytesToHex(PRF_WALLET),
    prfBackup: bytesToHex(PRF_BACKUP),
    password: PASSWORD,
    start: START,
  },
  draws: DRAWS.map((bytes, i) => ({
    length: hexToBytes(bytes).length,
    bytes,
    site: [
      "vault DEK",
      "vault factor wrap nonce",
      "session id",
      "nostr data-key DEK",
      "entropy record seal nonce",
      "nostr record id",
      "session id (unlock)",
      "backup BEK",
      "backup payload nonce",
      "backup password salt",
      "backup password sealedBek nonce",
      "backup passkey sealedBek nonce",
    ][i],
  })),
  walletId,
  envelope,
};

writeFileSync("vectors/backup.json", `${JSON.stringify(vector, null, 2)}\n`);
console.log(`vectors/backup.json: envelope ${envelope.length} chars, ${DRAWS.length} draws`);
