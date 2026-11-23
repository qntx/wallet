/**
 * The push-notification wire format, frozen by `vectors/push.json`: an APNs/FCM message carries
 * `{v, e, c}` — a 16-byte event id and `c`, the base64url-nopad encoding of `nonce(12) ‖
 * AES-256-GCM ciphertext ‖ tag(16)` under the subscription's payload key with `AAD =
 * ascii(PUSH_AAD_PREFIX + e)`. The plaintext is a small ASCII JSON document in exactly one
 * canonical serialization (`serializePushPlaintext`), so reordered, padded or extended documents
 * are malformed, not merely different.
 *
 * Deliberately zod-free: `@qntx/wallet-engine/push` bundles this module for notification extensions
 * (an iOS NSE, an RN headless task), so it shares the opener's floor — no globals beyond the ES
 * built-ins.
 */
export const PUSH_VERSION = 1;

export const PUSH_EVENT_KINDS = ["received", "sent", "failed", "reverted"] as const;
export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];

/** Subscription-id preimage: `id = hex(SHA-256(utf8(PUSH_ID_DOMAIN) ‖ secret))[0..32]`. */
export const PUSH_ID_DOMAIN = "qntx-push-id/1";
/** Event-id preimage — see {@link pushEventInput}. */
export const PUSH_EVENT_DOMAIN = "qntx-push-event/1";
/** AEAD associated data is `ascii(PUSH_AAD_PREFIX + eventId)`. */
export const PUSH_AAD_PREFIX = "qntx-push/1/";

/** The opener never trial-decrypts with more keys than this. */
export const PUSH_KEYS_MAX = 64;
/** Plaintext cap in bytes — the document is printable ASCII, so characters equal bytes. */
export const PUSH_PLAINTEXT_MAX = 1024;
/** `c` length cap in base64url characters. */
export const PUSH_BLOB_MAX = 2048;

/** What the provider delivers: `v` plus the opaque event id and the sealed blob. */
export type PushMessage = {
  readonly v: "1";
  readonly e: string;
  readonly c: string;
};

/** The one transfer involving the address, when there is exactly one — display-only. */
export type PushTransfer = {
  /** Amount, decimal in the asset's smallest unit. */
  readonly q: string;
  /** Decimal places of the asset. */
  readonly d?: number;
  /** Asset symbol. */
  readonly s?: string;
  /** Contract — absent for the native asset. */
  readonly c?: string;
};

/** The decrypted event — display-only; activity lists only ever re-read chain data. */
export type PushPlaintext = {
  readonly v: 1;
  readonly k: PushEventKind;
  /** CAIP-2 network id. */
  readonly n: string;
  /** Transaction hash. */
  readonly h: string;
  /** The subscription's address this event touches. */
  readonly a: string;
  /** Observation time, milliseconds since the epoch. */
  readonly t: number;
  readonly x?: PushTransfer;
};

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const ALNUM = /^[0-9A-Za-z]{1,128}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
/** A symbol neither starts nor ends with a space; spaces inside are fine. */
const SYMBOL = /^[!-~](?:[ -~]{0,14}[!-~])?$/;
const PRINTABLE = /^[ -~]+$/;
const EVENT_ID = /^[0-9a-f]{32}$/;
const BLOB = /^[A-Za-z0-9_-]+$/;
/** `nonce ‖ tag ‖ one plaintext byte` is 29 bytes, 39 base64url chars unpadded. */
const BLOB_MIN = Math.ceil(((12 + 16 + 1) * 4) / 3);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isKind = (value: unknown): value is PushEventKind =>
  (PUSH_EVENT_KINDS as ReadonlyArray<unknown>).includes(value);

/**
 * The event-id preimage: HMAC-SHA256 over this text under the payload key, first 16 bytes hex.
 * `generation` separates a re-included transaction's second "included" from its first.
 */
export function pushEventInput(
  network: string,
  hash: string,
  kind: PushEventKind,
  generation: number,
): string {
  return `${PUSH_EVENT_DOMAIN}\n${network}\n${hash}\n${kind}\n${generation}`;
}

/** The associated data a message's `e` binds the ciphertext to. */
export const pushAad = (eventId: string): string => PUSH_AAD_PREFIX + eventId;

/**
 * The canonical encoding the gateway encrypts: keys in the order `v,k,n,h,a,t,x` — inside `x`,
 * `q,d,s,c` — with absent optionals omitted. `JSON.stringify` emits keys in insertion order, so
 * building the document fresh is what fixes the order.
 */
export function serializePushPlaintext(p: PushPlaintext): string {
  const { x } = p;
  const transfer =
    x === undefined
      ? undefined
      : {
          q: x.q,
          ...(x.d === undefined ? {} : { d: x.d }),
          ...(x.s === undefined ? {} : { s: x.s }),
          ...(x.c === undefined ? {} : { c: x.c }),
        };
  return JSON.stringify({
    v: p.v,
    k: p.k,
    n: p.n,
    h: p.h,
    a: p.a,
    t: p.t,
    ...(transfer === undefined ? {} : { x: transfer }),
  });
}

const parseTransfer = (value: unknown): PushTransfer | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { q, d, s, c } = value;
  if (typeof q !== "string" || !AMOUNT.test(q)) {
    return undefined;
  }
  if (d !== undefined && (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 255)) {
    return undefined;
  }
  if (s !== undefined && (typeof s !== "string" || !SYMBOL.test(s))) {
    return undefined;
  }
  if (c !== undefined && (typeof c !== "string" || !ALNUM.test(c))) {
    return undefined;
  }
  return {
    q,
    ...(d === undefined ? {} : { d }),
    ...(s === undefined ? {} : { s }),
    ...(c === undefined ? {} : { c }),
  };
};

/**
 * The inverse of `serializePushPlaintext` — field types are checked before the canonical
 * re-serialization comparison, which rejects duplicate keys, reordering, whitespace and unknown
 * keys in one step. Returns `undefined` on any violation; never throws.
 */
export function parsePushPlaintext(text: string): PushPlaintext | undefined {
  if (text.length > PUSH_PLAINTEXT_MAX || !PRINTABLE.test(text)) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { v, k, n, h, a, t, x } = value;
  if (v !== PUSH_VERSION || !isKind(k)) {
    return undefined;
  }
  if (typeof n !== "string" || !CAIP2.test(n)) {
    return undefined;
  }
  if (typeof h !== "string" || !ALNUM.test(h)) {
    return undefined;
  }
  if (typeof a !== "string" || !ALNUM.test(a)) {
    return undefined;
  }
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) {
    return undefined;
  }
  const transfer = x === undefined ? undefined : parseTransfer(x);
  if (x !== undefined && transfer === undefined) {
    return undefined;
  }
  const doc: PushPlaintext = {
    v: PUSH_VERSION,
    k,
    n,
    h,
    a,
    t,
    ...(transfer === undefined ? {} : { x: transfer }),
  };
  return serializePushPlaintext(doc) === text ? doc : undefined;
}

/**
 * The message shape a host pulls out of an APNs `qntx` key or an FCM data map — extra keys are
 * ignored because those maps carry provider SDK entries too. Never throws.
 */
export function parsePushMessage(value: unknown): PushMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { v, e, c } = value;
  if (v !== String(PUSH_VERSION)) {
    return undefined;
  }
  if (typeof e !== "string" || !EVENT_ID.test(e)) {
    return undefined;
  }
  if (typeof c !== "string" || c.length < BLOB_MIN || c.length > PUSH_BLOB_MAX || !BLOB.test(c)) {
    return undefined;
  }
  return { v: "1", e, c };
}
