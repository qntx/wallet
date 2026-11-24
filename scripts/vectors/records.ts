/// <reference types="node" />
/**
 * Regenerates vectors/records.json without importing kernel code: each `text` is the exact JSON a
 * VAULT_FORMAT-6 store persists as a record/factor public header (or the vault meta object),
 * written out key by key in the documented order. `input` is the field set the parser returns.
 *
 * Key orders (must match the encoders):
 *
 * - Entropy: walletId, origin, words, [passphrase: true,] backup, createdAt
 * - Data-key: purpose, createdAt
 * - Imported key: family, address, createdAt
 * - Session key: scheme, walletId, groupIndex, owner, scope, name, validUntil, createdAt, [limits,]
 *   [spent]
 * - Hardware wallet: device, fingerprint, [model,] [firmware,] createdAt
 * - Nostr derived: publicKey, walletId, index, createdAt
 * - Nostr sync key: publicKey, walletId, createdAt
 * - Password factor: salt, iterations, publicKey, createdAt
 * - Passkey factor: credentialId, publicKey, createdAt
 * - Hardware factor: sealedKek, publicKey, createdAt
 * - Backup key: id, factors, createdAt
 * - Vault meta: format, revision, keyId
 *
 * Run from the repo root: bun scripts/vectors/records.ts
 */
import { writeFileSync } from "node:fs";

const PUBLIC_KEY = "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917";
const WALLET_ID = "0011223344556677";
const CREATED_AT = 1767225600000;

type Input = Record<string, unknown>;

/** The exact stored text for one vector, spelled out in the format's key order. */
function textOf(kind: string, input: Input): string {
  const i = input;
  switch (kind) {
    case "entropy":
      return JSON.stringify({
        walletId: i["walletId"],
        origin: i["origin"],
        words: i["words"],
        ...(i["passphrase"] === undefined ? {} : { passphrase: i["passphrase"] }),
        backup: i["backup"],
        createdAt: i["createdAt"],
      });
    case "data-key":
      return JSON.stringify({ purpose: i["purpose"], createdAt: i["createdAt"] });
    case "key":
      return JSON.stringify({
        family: i["family"],
        address: i["address"],
        createdAt: i["createdAt"],
      });
    case "session-key":
      return JSON.stringify({
        scheme: i["scheme"],
        walletId: i["walletId"],
        groupIndex: i["groupIndex"],
        owner: i["owner"],
        scope: i["scope"],
        name: i["name"],
        validUntil: i["validUntil"],
        createdAt: i["createdAt"],
        ...(i["limits"] === undefined ? {} : { limits: i["limits"] }),
        ...(i["spent"] === undefined ? {} : { spent: i["spent"] }),
      });
    case "hardware-wallet":
      return JSON.stringify({
        device: i["device"],
        fingerprint: i["fingerprint"],
        ...(i["model"] === undefined ? {} : { model: i["model"] }),
        ...(i["firmware"] === undefined ? {} : { firmware: i["firmware"] }),
        createdAt: i["createdAt"],
      });
    case "nostr-derived":
      return JSON.stringify({
        publicKey: i["publicKey"],
        walletId: i["walletId"],
        index: i["index"],
        createdAt: i["createdAt"],
      });
    case "nostr-sync-key":
      return JSON.stringify({
        publicKey: i["publicKey"],
        walletId: i["walletId"],
        createdAt: i["createdAt"],
      });
    case "factor-password":
      return JSON.stringify({
        salt: i["salt"],
        iterations: i["iterations"],
        publicKey: i["publicKey"],
        createdAt: i["createdAt"],
      });
    case "factor-passkey":
      return JSON.stringify({
        credentialId: i["credentialId"],
        publicKey: i["publicKey"],
        createdAt: i["createdAt"],
      });
    case "factor-keystore":
      return JSON.stringify({
        sealedKek: i["sealedKek"],
        publicKey: i["publicKey"],
        createdAt: i["createdAt"],
      });
    case "backup-key":
      return JSON.stringify({
        id: i["id"],
        factors: i["factors"],
        createdAt: i["createdAt"],
      });
    case "meta":
      return JSON.stringify({
        format: i["format"],
        revision: i["revision"],
        keyId: i["keyId"],
      });
    default:
      throw new Error(`unknown kind: ${kind}`);
  }
}

const cases: Array<{ name: string; kind: string; input: Input }> = [
  {
    name: "entropy-mnemonic",
    kind: "entropy",
    input: {
      walletId: WALLET_ID,
      origin: "mnemonic",
      words: 12,
      backup: "mnemonic",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "entropy-mnemonic-passphrase",
    kind: "entropy",
    input: {
      walletId: "a8a96711dff685cb",
      origin: "mnemonic",
      words: 12,
      passphrase: true,
      backup: "mnemonic",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "entropy-passkey-synced",
    kind: "entropy",
    input: {
      walletId: WALLET_ID,
      origin: "passkey",
      words: 12,
      backup: "passkey",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "entropy-passkey-device-bound",
    kind: "entropy",
    input: {
      walletId: WALLET_ID,
      origin: "passkey",
      words: 12,
      backup: "none",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "data-key",
    kind: "data-key",
    input: { purpose: "backup", createdAt: CREATED_AT },
  },
  {
    name: "key-evm",
    kind: "key",
    input: {
      family: "evm",
      address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "key-solana",
    kind: "key",
    input: {
      family: "solana",
      address: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "session-key",
    kind: "session-key",
    input: {
      scheme: "hyperliquid-l1-agent",
      walletId: WALLET_ID,
      groupIndex: 0,
      owner: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      scope: "Mainnet",
      name: "bot-1",
      validUntil: CREATED_AT + 180 * 86_400_000,
      createdAt: CREATED_AT,
      limits: {
        notional: "10000",
        maxLeverage: 25,
        assets: [0, 1, 2, 3, 10007].map((asset) => ({ asset, size: "10000" })),
      },
      spent: { notional: "0", size: ["0", "0", "0", "0", "0"] },
    },
  },
  {
    name: "session-key-unknown",
    kind: "session-key",
    input: {
      scheme: "future-scheme",
      walletId: WALLET_ID,
      groupIndex: 0,
      owner: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      scope: `0x${"11".repeat(20)}`,
      name: "bot-2",
      validUntil: CREATED_AT + 180 * 86_400_000,
      createdAt: CREATED_AT,
    },
  },
  {
    name: "hardware-wallet",
    kind: "hardware-wallet",
    input: {
      device: "keystone",
      fingerprint: "73c5da0a",
      model: "Keystone 3 Pro",
      firmware: "1.7.2",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "hardware-wallet-minimal",
    kind: "hardware-wallet",
    input: {
      device: "keystone",
      fingerprint: "0123abcd",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "nostr-derived",
    kind: "nostr-derived",
    input: {
      publicKey: PUBLIC_KEY,
      walletId: WALLET_ID,
      index: 0,
      createdAt: CREATED_AT,
    },
  },
  {
    name: "nostr-sync-key",
    kind: "nostr-sync-key",
    input: {
      publicKey: PUBLIC_KEY,
      walletId: WALLET_ID,
      createdAt: CREATED_AT,
    },
  },
  {
    name: "factor-password",
    kind: "factor-password",
    input: {
      salt: "ABEiM0RVZneImaq7zN3u_w",
      iterations: 600000,
      publicKey: "PxLfxal_e43m4jpaNusYyCfYFXOkFoQAQ1lQI1s0HUM",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "factor-passkey",
    kind: "factor-passkey",
    input: {
      credentialId: "3q2-78r-",
      publicKey: "JqRYFT66Kmogg041szL7sSC6lKDj6VPKh-5HsP3DbAE",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "factor-keystore",
    kind: "factor-keystore",
    input: {
      sealedKek: "BEEtHwKDkZ8R7gtb2AqUQ2Hcj8uLsMLtzHWiXaOL8mPZ2LsHvKG7vPDhWmrUTe0f8x8",
      publicKey: "PxLfxal_e43m4jpaNusYyCfYFXOkFoQAQ1lQI1s0HUM",
      createdAt: CREATED_AT,
    },
  },
  {
    name: "backup-key",
    kind: "backup-key",
    input: {
      id: "23df0b4731653063ad34952b8470c452",
      factors: [
        {
          kind: "password",
          kdf: "argon2id",
          memoryKiB: 65536,
          passes: 3,
          lanes: 4,
          salt: "EhISEhISEhISEhISEhISEg",
          sealedBek: "ARM3VgDqQ6vS7Jy5N7o8pP0xV1cQW4J0jR8vS0zP8y3lM9uR2wQ6y8xL1nB4vQ7y8xK1",
        },
        {
          kind: "passkey",
          credentialId: "YmFja3VwLXZlY3Rvci1jcmVkZW50aWFs",
          sealedBek: "ARM3VgDqQ6vS7Jy5N7o8pP0xV1cQW4J0jR8vS0zP8y3lM9uR2wQ6y8xL1nB4vQ7y8xK1",
        },
      ],
      createdAt: 1767225600000,
    },
  },
  {
    name: "meta",
    kind: "meta",
    input: {
      format: 6,
      revision: 1,
      keyId: "00112233445566778899aabbccddeeff",
    },
  },
];

const out = {
  comment:
    "Exact public-header and vault-meta texts (VAULT_FORMAT 6) generated by scripts/vectors/records.ts — independent of the kernel. Each input is the parsed field set; text is the stored JSON.",
  vectors: cases.map(({ name, kind, input }) => ({
    name,
    kind,
    input,
    text: textOf(kind, input),
  })),
};

writeFileSync("vectors/records.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote vectors/records.json");
