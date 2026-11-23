/// <reference types="node" />
/**
 * Regenerates vectors/push.json without importing engine or gateway code — the independent oracle
 * for the push wire format, computed through Node's WebCrypto (`crypto.subtle`):
 *
 * SubscriptionId = hex(SHA-256(UTF-8("qntx-push-id/1") ‖ secret))[0..16] eventId =
 * hex(HMAC-SHA256(key, UTF-8(input)))[0..16] input = "qntx-push-event/1\n" + network + "\n" + hash +
 * "\n" + kind + "\n" + generation message.c = base64url-nopad(nonce(12) ‖ AES-256-GCM(key, nonce,
 * plaintext, aad)) message aad = ASCII("qntx-push/1/" + eventId) seal = base64url-nopad(nonce(12) ‖
 * AES-256-GCM(sealKey, nonce, plaintext, aad)) seal aad = ASCII(family + "/" + id)
 *
 * Plaintexts are written in the canonical serialization the contract fixes — key order
 * v,k,n,h,a,t,x (inside x: q,d,s,c), absent optionals omitted — exactly as they appear on the
 * wire.
 *
 * Run from the repo root: bun scripts/vectors/push.ts
 */
import { writeFileSync } from "node:fs";

/** WebCrypto takes `BufferSource` — non-shared views only, so every byte buffer here is pinned. */
type Bytes = Buffer<ArrayBuffer>;

const utf8 = (text: string): Bytes => Buffer.from(text, "utf8");
const ascii = (text: string): Bytes => Buffer.from(text, "ascii");
const unhex = (text: string): Bytes => Buffer.from(text, "hex");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const sha256 = async (data: Bytes): Promise<Bytes> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", data));

const hmacSha256 = async (key: Bytes, data: Bytes): Promise<Bytes> => {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return Buffer.from(await crypto.subtle.sign("HMAC", k, data));
};

const aesGcm = async (key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes): Promise<Bytes> => {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  return Buffer.from(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, k, plaintext),
  );
};

const ID_DOMAIN = "qntx-push-id/1";
const EVENT_DOMAIN = "qntx-push-event/1";
const AAD_PREFIX = "qntx-push/1/";

const eventInput = (network: string, hash: string, kind: string, generation: number): string =>
  `${EVENT_DOMAIN}\n${network}\n${hash}\n${kind}\n${generation}`;

const eventIdOf = async (
  key: Bytes,
  network: string,
  hash: string,
  kind: string,
  generation: number,
): Promise<string> => {
  const digest = await hmacSha256(key, utf8(eventInput(network, hash, kind, generation)));
  return hex(digest.subarray(0, 16));
};

type Plaintext = {
  v: 1;
  k: string;
  n: string;
  h: string;
  a: string;
  t: number;
  x?: { q: string; d?: number; s?: string; c?: string };
};

/** The canonical key order the contract fixes — the gateway encrypts exactly this text. */
const canonical = (p: Plaintext): string =>
  JSON.stringify({
    v: p.v,
    k: p.k,
    n: p.n,
    h: p.h,
    a: p.a,
    t: p.t,
    ...(p.x === undefined
      ? {}
      : {
          x: {
            q: p.x.q,
            ...(p.x.d === undefined ? {} : { d: p.x.d }),
            ...(p.x.s === undefined ? {} : { s: p.x.s }),
            ...(p.x.c === undefined ? {} : { c: p.x.c }),
          },
        }),
  });

const EVM_HASH = `0x${"ab".repeat(32)}`;
const BTC_HASH = "9f".repeat(32);
const EVM_ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const BTC_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const EVM_NETWORK = "eip155:1";
const BTC_NETWORK = "bip122:00000008819873e925422c1ff0f99f7c";

const KEY_A = unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const KEY_B = unhex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");
const KEY_C = unhex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f");
const SEAL_KEY = unhex("606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f");

const NONCE_A = unhex("e0e1e2e3e4e5e6e7e8e9eaeb");
const NONCE_B = unhex("f0f1f2f3f4f5f6f7f8f9fafb");
const NONCE_C = unhex("c0c1c2c3c4c5c6c7c8c9cacb");
const NONCE_D = unhex("d0d1d2d3d4d5d6d7d8d9dadb");
const NONCE_E = unhex("a0a1a2a3a4a5a6a7a8a9aaab");
const NONCE_F = unhex("b0b1b2b3b4b5b6b7b8b9babb");

const SECRETS = [
  "0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021222324252627",
  "1a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637",
  "2a2b2c2d2e2f303132333435363738393a3b3c3d3e3f4041424344454647",
] as const;

const subscriptionIds = await Promise.all(
  SECRETS.map(async (secret) => {
    const digest = await sha256(Buffer.concat([utf8(ID_DOMAIN), unhex(secret)]));
    return { secret, id: hex(digest.subarray(0, 16)) };
  }),
);

const EVENT_CASES: ReadonlyArray<{
  readonly name: string;
  readonly key: Bytes;
  readonly network: string;
  readonly hash: string;
  readonly kind: string;
  readonly generation: number;
}> = [
  {
    name: "received-evm",
    key: KEY_A,
    network: EVM_NETWORK,
    hash: EVM_HASH,
    kind: "received",
    generation: 0,
  },
  {
    name: "sent-evm",
    key: KEY_A,
    network: EVM_NETWORK,
    hash: EVM_HASH,
    kind: "sent",
    generation: 0,
  },
  {
    name: "failed-bitcoin",
    key: KEY_B,
    network: BTC_NETWORK,
    hash: BTC_HASH,
    kind: "failed",
    generation: 2,
  },
  {
    name: "reverted-bitcoin",
    key: KEY_B,
    network: BTC_NETWORK,
    hash: BTC_HASH,
    kind: "reverted",
    generation: 2,
  },
];

const eventIds = await Promise.all(
  EVENT_CASES.map(async (c) => ({
    name: c.name,
    key: hex(c.key),
    network: c.network,
    hash: c.hash,
    kind: c.kind,
    generation: c.generation,
    input: eventInput(c.network, c.hash, c.kind, c.generation),
    eventId: await eventIdOf(c.key, c.network, c.hash, c.kind, c.generation),
  })),
);

type MessageCase = {
  readonly name: string;
  readonly key: Bytes;
  readonly nonce: Bytes;
  readonly generation: number;
  readonly plaintext: Plaintext;
};

const MESSAGE_CASES: ReadonlyArray<MessageCase> = [
  {
    name: "received-with-transfer",
    key: KEY_A,
    nonce: NONCE_A,
    generation: 0,
    plaintext: {
      v: 1,
      k: "received",
      n: EVM_NETWORK,
      h: EVM_HASH,
      a: EVM_ADDRESS,
      t: 1767225600000,
      x: { q: "1500000", d: 6, s: "USDC", c: `0x${"c5".repeat(20)}` },
    },
  },
  {
    name: "sent-amount-only",
    key: KEY_B,
    nonce: NONCE_B,
    generation: 0,
    plaintext: {
      v: 1,
      k: "sent",
      n: EVM_NETWORK,
      h: EVM_HASH,
      a: EVM_ADDRESS,
      t: 1767225700000,
      x: { q: "42000000000000000000" },
    },
  },
  {
    name: "failed-outgoing",
    key: KEY_A,
    nonce: NONCE_C,
    generation: 0,
    plaintext: {
      v: 1,
      k: "failed",
      n: EVM_NETWORK,
      h: EVM_HASH,
      a: EVM_ADDRESS,
      t: 1767225800000,
      x: { q: "7000000000000000", d: 18 },
    },
  },
  {
    name: "reverted-bitcoin",
    key: KEY_B,
    nonce: NONCE_D,
    generation: 1,
    plaintext: {
      v: 1,
      k: "reverted",
      n: BTC_NETWORK,
      h: BTC_HASH,
      a: BTC_ADDRESS,
      t: 1767225900000,
    },
  },
];

const messages = await Promise.all(
  MESSAGE_CASES.map(async (c) => {
    const eventId = await eventIdOf(
      c.key,
      c.plaintext.n,
      c.plaintext.h,
      c.plaintext.k,
      c.generation,
    );
    const plaintext = canonical(c.plaintext);
    const sealed = await aesGcm(c.key, c.nonce, utf8(plaintext), ascii(`${AAD_PREFIX}${eventId}`));
    return {
      name: c.name,
      key: hex(c.key),
      eventId,
      nonce: hex(c.nonce),
      generation: c.generation,
      plaintext,
      message: { v: "1", e: eventId, c: b64u(Buffer.concat([c.nonce, sealed])) },
    };
  }),
);

/** Encrypts `text` for a reject case: a blob that opens but must still be refused. */
const envelope = async (
  key: Bytes,
  nonce: Bytes,
  eventId: string,
  text: string,
): Promise<{ v: string; e: string; c: string }> => {
  const sealed = await aesGcm(key, nonce, utf8(text), ascii(`${AAD_PREFIX}${eventId}`));
  return { v: "1", e: eventId, c: b64u(Buffer.concat([nonce, sealed])) };
};

const [base] = messages;
if (base === undefined) {
  throw new Error("no message vectors");
}
const baseBytes = Buffer.concat([
  NONCE_A,
  await aesGcm(KEY_A, NONCE_A, utf8(base.plaintext), ascii(`${AAD_PREFIX}${base.eventId}`)),
]);
const tamperedCipher = Buffer.from(baseBytes);
tamperedCipher[20] = ((tamperedCipher[20] ?? 0) + 1) % 256;
const tamperedTag = Buffer.from(baseBytes);
tamperedTag[tamperedTag.length - 1] = ((tamperedTag.at(-1) ?? 0) + 1) % 256;

const nonCanonical = base.plaintext.replace('"v":1', '"v":1 ');
const withUnknownKey = `${base.plaintext.slice(0, -1)},"z":1}`;
const nonAscii = base.plaintext.replace('"USDC"', '"USDCé"');
const versionTwo = base.plaintext.replace('"v":1', '"v":2');
const swappedId = messages[1]?.eventId ?? base.eventId;

const rejects = [
  {
    reason: "tampered ciphertext byte — GCM auth fails",
    message: { v: "1", e: base.eventId, c: b64u(tamperedCipher) },
    keys: [hex(KEY_A)],
  },
  {
    reason: "tampered tag — GCM auth fails",
    message: { v: "1", e: base.eventId, c: b64u(tamperedTag) },
    keys: [hex(KEY_A)],
  },
  {
    reason: "encrypted under another key — no key opens it",
    message: {
      v: "1",
      e: base.eventId,
      c: b64u(
        Buffer.concat([
          NONCE_B,
          await aesGcm(KEY_B, NONCE_B, utf8(base.plaintext), ascii(`${AAD_PREFIX}${base.eventId}`)),
        ]),
      ),
    },
    keys: [hex(KEY_A), hex(KEY_C)],
  },
  {
    reason: "event id swapped for another valid one — the AAD no longer matches",
    message: { v: "1", e: swappedId, c: base.message.c },
    keys: [hex(KEY_A)],
  },
  {
    reason: "truncated blob — too short to carry a nonce, plaintext and tag",
    message: {
      v: "1",
      e: base.eventId,
      c: b64u(baseBytes.subarray(0, 29)),
    },
    keys: [hex(KEY_A)],
  },
  {
    reason: "opens but the plaintext is not canonical — extra space after a colon",
    message: await envelope(KEY_A, NONCE_A, base.eventId, nonCanonical),
    keys: [hex(KEY_A)],
  },
  {
    reason: "opens but the plaintext carries an unknown key",
    message: await envelope(KEY_A, NONCE_A, base.eventId, withUnknownKey),
    keys: [hex(KEY_A)],
  },
  {
    reason: "opens but the plaintext is not ASCII",
    message: await envelope(KEY_A, NONCE_A, base.eventId, nonAscii),
    keys: [hex(KEY_A)],
  },
  {
    reason: "opens but the plaintext is a different version",
    message: await envelope(KEY_A, NONCE_A, base.eventId, versionTwo),
    keys: [hex(KEY_A)],
  },
];

const SEAL_CASES: ReadonlyArray<{
  readonly family: string;
  readonly nonce: Bytes;
  readonly plaintext: { p: string; t: string; k: string };
}> = [
  {
    family: "evm",
    nonce: NONCE_E,
    plaintext: { p: "apns", t: "ab".repeat(32), k: b64u(KEY_A) },
  },
  {
    family: "bitcoin",
    nonce: NONCE_F,
    plaintext: { p: "fcm", t: `fcm-token-${"xy".repeat(20)}`, k: b64u(KEY_B) },
  },
];

const seals = await Promise.all(
  SEAL_CASES.map(async (c) => {
    const digest = await sha256(Buffer.concat([utf8(ID_DOMAIN), unhex(SECRETS[0])]));
    const id = hex(digest.subarray(0, 16));
    const aad = `${c.family}/${id}`;
    const plaintext = JSON.stringify({ p: c.plaintext.p, t: c.plaintext.t, k: c.plaintext.k });
    const sealed = await aesGcm(SEAL_KEY, c.nonce, utf8(plaintext), ascii(aad));
    return {
      sealKey: hex(SEAL_KEY),
      family: c.family,
      id,
      nonce: hex(c.nonce),
      plaintext,
      aad,
      sealed: b64u(Buffer.concat([c.nonce, sealed])),
    };
  }),
);

const out = {
  comment: [
    "Push wire-format vectors generated by scripts/vectors/push.ts (Node WebCrypto,",
    "independent of the engine). subscriptionId = hex(SHA-256('qntx-push-id/1' ‖ secret))[0..16];",
    String.raw`eventId = hex(HMAC-SHA256(key, 'qntx-push-event/1\n' ‖ network ‖ '\n' ‖ hash ‖ '\n' ‖ kind`,
    String.raw`‖ '\n' ‖ generation))[0..16]; message.c = base64url-nopad(nonce ‖ AES-256-GCM(key, nonce,`,
    "plaintext, aad = 'qntx-push/1/' ‖ eventId)); sealed = the same construction for the",
    "gateway's token envelope with aad = family ‖ '/' ‖ id. `rejects` are messages and keys",
    "that must not open: wrong keys, GCM tampering, AAD mismatches and well-sealed but",
    "non-canonical or out-of-shape plaintexts.",
  ].join(" "),
  domains: { id: ID_DOMAIN, event: EVENT_DOMAIN, aad: AAD_PREFIX },
  subscriptionIds,
  eventIds,
  messages,
  rejects,
  seals,
};

writeFileSync("vectors/push.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `vectors/push.json: ${messages.length} messages, ${rejects.length} rejects, ${seals.length} seals`,
);
