/// <reference types="node" />
/**
 * Regenerates vectors/vault/card-wallet.json without importing kernel code: the canonical
 * `card-wallet` record encodings — the public header text and the sealed body's UTF-8 JSON — plus
 * rejection cases, one per invariant the parsers enforce.
 *
 * Everything is computed independently: the master key and cached nodes come straight from
 *
 * @scure/bip32 on the fixed seed, the ed25519 entry from micro-key-producer's SLIP-10 +
 * @noble/curves, the wallet id from node:crypto sha256("qntx-wallet/wallet-id/v1" ‖ master)[0..8],
 * and the pinned cert is card1's `verify` entry from vectors/card/cert.json (the second member is
 * left unknown). Texts are spelled out key by key in the encoders' order — header
 * (v, walletId, origin, createdAt, members, cards) and body
 * (master, nodes, ed25519, ephemerals, access) with lexically sorted inner maps.
 *
 * Run from the repo root: bun scripts/vectors/card-wallet.ts
 */
// oxlint-disable typescript/no-unsafe-type-assertion -- rejects mutate a parsed copy of the
// canonical document whose shape the cases below name by construction.
// oxlint-disable typescript/no-non-null-assertion -- same reason: indexes into that known shape.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";

const sha256 = (data: Uint8Array): Uint8Array => createHash("sha256").update(data).digest();
const walletId = (master: Uint8Array): string =>
  bytesToHex(
    sha256(
      new Uint8Array([...new TextEncoder().encode("qntx-wallet/wallet-id/v1"), ...master]),
    ).subarray(0, 8),
  );
const cardId = (identity: Uint8Array): string => bytesToHex(sha256(identity).subarray(0, 16));

// BIP-32 vector-1's seed — the same seed vectors/card/derivation.json and wallet-id.json use.
const SEED = "000102030405060708090a0b0c0d0e0f";
const CREATED_AT = 1_770_000_000_000;

const cert = (
  JSON.parse(readFileSync("vectors/card/cert.json", "utf8")) as {
    verify: Array<{ name: string; cert: string }>;
  }
).verify.find((entry) => entry.name === "card1-under-ca1");
if (cert === undefined) {
  throw new Error("vectors/card/cert.json has no card1-under-ca1 entry");
}
const CERT = cert.cert;
const CARD_ID = cardId(hexToBytes(CERT.slice(0, 66)));
const OTHER_ID = `${"00".repeat(15)}ff`; // member with no pinned cert

const master = HDKey.fromMasterSeed(hexToBytes(SEED));
const masterPublic = master.publicKey;
if (masterPublic === null) {
  throw new Error("no master public key");
}
const WALLET_ID = walletId(masterPublic);

/** Compressed key + chain code at `path`, the shape a tap caches under `nodes`. */
const nodeAt = (path: string): { key: string; chainCode: string } => {
  const node = master.derive(path);
  if (node.publicKey === null || node.chainCode === null) {
    throw new Error(`no public key at ${path}`);
  }
  return { key: bytesToHex(node.publicKey), chainCode: bytesToHex(node.chainCode) };
};

/** SLIP-10 spelled out: every ed25519 step is hardened, HMAC-SHA512("ed25519 seed" ‖ chain). */
const hmac512 = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  createHmac("sha512", key).update(data).digest();
const slip10Child = (
  key: Uint8Array,
  chainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } => {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index);
  const out = hmac512(chainCode, new Uint8Array([0, ...key, ...indexBytes]));
  return { key: out.subarray(0, 32), chainCode: out.subarray(32) };
};
const slip10 = (seed: Uint8Array, indices: ReadonlyArray<number>): Uint8Array => {
  const masterI = hmac512(new TextEncoder().encode("ed25519 seed"), seed);
  let node = { key: masterI.subarray(0, 32), chainCode: masterI.subarray(32) };
  for (const index of indices) {
    node = slip10Child(node.key, node.chainCode, index);
  }
  return node.key;
};
const HARDENED = 0x80000000;
const ed25519At = (path: string): string =>
  bytesToHex(
    ed25519.getPublicKey(
      slip10(
        hexToBytes(SEED),
        path
          .slice(2)
          .split("/")
          .map((segment) => Number(segment.replaceAll("'", "")) + HARDENED),
      ),
    ),
  );

/* The fixed wallet: two members — card1's cert pinned (ready, tries 10, verified) and one member
 * the kernel never saw (unknown, no cert). The body caches the registration set a tap leaves:
 * account nodes for evm/tron/bitcoin purposes plus the solana SLIP-10 leaf, one ephemeral tag per
 * card and a remembered access hash for the pinned card. */
const headerInput = {
  v: 1,
  walletId: WALLET_ID,
  origin: "generated",
  createdAt: CREATED_AT,
  members: [CARD_ID, OTHER_ID],
  cards: [
    { cardId: CARD_ID, cert: CERT, state: "ready", tries: 10, verifiedAt: CREATED_AT },
    { cardId: OTHER_ID, state: "unknown" },
  ],
};

const bodyInput = {
  master: bytesToHex(masterPublic),
  // Canonical order — the encoder sorts node paths lexically; keep this list sorted.
  nodes: {
    "m/44'/195'/0'": nodeAt("m/44'/195'/0'"),
    "m/44'/60'/0'": nodeAt("m/44'/60'/0'"),
    "m/84'/0'/0'": nodeAt("m/84'/0'/0'"),
    "m/84'/0'/0'/0'": nodeAt("m/84'/0'/0'/0'"),
  },
  ed25519: { "m/44'/501'/0'/0'": ed25519At("m/44'/501'/0'/0'") },
  ephemerals: {
    [OTHER_ID]: ["deadbeefdeadbeef"],
    [CARD_ID]: ["0011223344556677", "8899aabbccddeeff"],
  },
  access: {
    [CARD_ID]: sha256(new TextEncoder().encode("access hash")).reduce(
      (acc, b) => acc + b.toString(16).padStart(2, "0"),
      "",
    ),
  },
};

const headerText = JSON.stringify(headerInput);
const bodyText = JSON.stringify({
  master: bodyInput.master,
  nodes: bodyInput.nodes,
  ed25519: bodyInput.ed25519,
  ephemerals: bodyInput.ephemerals,
  access: bodyInput.access,
});

type Reject = { name: string; side: "header" | "body"; text: string };
const mutate = (text: string, patch: (value: Record<string, unknown>) => void): string => {
  const value = JSON.parse(text) as Record<string, unknown>;
  patch(value);
  return JSON.stringify(value);
};

const rejects: Reject[] = [
  {
    name: "header-extra-key",
    side: "header",
    text: mutate(headerText, (v) => {
      v["extra"] = true;
    }),
  },
  {
    name: "header-version",
    side: "header",
    text: mutate(headerText, (v) => {
      v["v"] = 2;
    }),
  },
  {
    name: "header-members-empty",
    side: "header",
    text: mutate(headerText, (v) => {
      v["members"] = [];
    }),
  },
  {
    name: "header-members-four",
    side: "header",
    text: mutate(headerText, (v) => {
      v["members"] = [...(v["members"] as string[]), "11".repeat(16), "22".repeat(16)];
    }),
  },
  {
    name: "header-card-not-member",
    side: "header",
    text: mutate(headerText, (v) => {
      (v["cards"] as Array<Record<string, unknown>>)[1]!["cardId"] = "11".repeat(16);
    }),
  },
  {
    name: "header-card-cert-mismatch",
    side: "header",
    text: mutate(headerText, (v) => {
      // Pin the cert under the other member's id — cardId(cert) no longer equals cardId.
      const cards = v["cards"] as Array<Record<string, unknown>>;
      cards[0]!["cardId"] = OTHER_ID;
      cards[1]!["cardId"] = CARD_ID;
    }),
  },
  {
    name: "header-card-state",
    side: "header",
    text: mutate(headerText, (v) => {
      (v["cards"] as Array<Record<string, unknown>>)[0]!["state"] = "dead";
    }),
  },
  {
    name: "header-card-tries-range",
    side: "header",
    text: mutate(headerText, (v) => {
      (v["cards"] as Array<Record<string, unknown>>)[0]!["tries"] = 11;
    }),
  },
  {
    name: "header-card-duplicate",
    side: "header",
    text: mutate(headerText, (v) => {
      (v["cards"] as Array<Record<string, unknown>>)[1]!["cardId"] = CARD_ID;
    }),
  },
  {
    name: "body-extra-key",
    side: "body",
    text: mutate(bodyText, (v) => {
      v["extra"] = true;
    }),
  },
  {
    name: "body-master-wallet-id",
    side: "body",
    text: mutate(bodyText, (v) => {
      // A point that exists but does not derive this record's walletId.
      v["master"] = bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true));
    }),
  },
  {
    name: "body-node-path-depth",
    side: "body",
    text: mutate(bodyText, (v) => {
      const nodes = v["nodes"] as Record<string, unknown>;
      nodes["m/1/2/3/4/5/6/7/8/9/10/11"] = nodes["m/44'/195'/0'"];
    }),
  },
  {
    name: "body-node-key-not-point",
    side: "body",
    text: mutate(bodyText, (v) => {
      const nodes = v["nodes"] as Record<string, Record<string, unknown>>;
      nodes["m/44'/195'/0'"]!["key"] = `04${"00".repeat(32)}`;
    }),
  },
  {
    name: "body-node-chain-code",
    side: "body",
    text: mutate(bodyText, (v) => {
      const nodes = v["nodes"] as Record<string, Record<string, unknown>>;
      nodes["m/44'/195'/0'"]!["chainCode"] = "00".repeat(31);
    }),
  },
  {
    name: "body-ed25519-not-point",
    side: "body",
    text: mutate(bodyText, (v) => {
      (v["ed25519"] as Record<string, unknown>)["m/44'/501'/0'/0'"] = "ff".repeat(32);
    }),
  },
  {
    name: "body-ephemeral-tag-length",
    side: "body",
    text: mutate(bodyText, (v) => {
      const tags = (v["ephemerals"] as Record<string, string[]>)[CARD_ID]!;
      tags.push("00".repeat(9));
    }),
  },
  {
    name: "body-ephemeral-card-id",
    side: "body",
    text: mutate(bodyText, (v) => {
      // An ephemerals key that is not a cardId.
      (v["ephemerals"] as Record<string, string[]>)["22".repeat(8)] = ["0011223344556677"];
    }),
  },
  {
    name: "body-ephemeral-tag-count",
    side: "body",
    text: mutate(bodyText, (v) => {
      (v["ephemerals"] as Record<string, string[]>)[CARD_ID] = Array.from({ length: 17 }, (_, i) =>
        i.toString(16).padStart(2, "0").repeat(8),
      );
    }),
  },
  {
    name: "body-access-length",
    side: "body",
    text: mutate(bodyText, (v) => {
      (v["access"] as Record<string, unknown>)[CARD_ID] = "00".repeat(31);
    }),
  },
];

const out = {
  comment:
    'Canonical card-wallet record encodings (public header + sealed body\'s JSON) generated by scripts/vectors/card-wallet.ts — independent of the kernel. `walletId` is SHA-256("qntx-wallet/wallet-id/v1" ‖ master)[0..8]; the pinned cert is card1-under-ca1 from vectors/card/cert.json; rejects each break one parser invariant.',
  seed: SEED,
  walletId: WALLET_ID,
  header: { input: headerInput, text: headerText },
  body: { input: bodyInput, text: bodyText },
  rejects: rejects.map(({ name, side, text }) => ({ name, side, text })),
};

writeFileSync("vectors/vault/card-wallet.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote vectors/vault/card-wallet.json");
