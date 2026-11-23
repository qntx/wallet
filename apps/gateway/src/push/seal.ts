/**
 * The push sealing primitives — WebCrypto only, byte-frozen by `vectors/push.json`: a subscription
 * id is `hex(SHA-256(utf8(PUSH_ID_DOMAIN) ‖ secret))[0..32]`, an event id is
 * `hex(HMAC-SHA256(payloadKey, utf8(pushEventInput(...)))[0..32])`, and a sealed blob is
 * `base64url-nopad(nonce ‖ AES-256-GCM ciphertext ‖ tag)`. Callers draw the nonce, so tests can pin
 * it and production injects `crypto.getRandomValues`.
 */
import {
  PUSH_ID_DOMAIN,
  PUSH_PLATFORMS,
  accepts,
  pushAad,
  pushEventInput,
  pushSecret,
} from "@qntx/wallet-engine/gateway/contract";
import type { PushEventKind, PushFamily, PushPlatform } from "@qntx/wallet-engine/gateway/contract";

import {
  base64Bytes,
  base64urlBytes,
  base64urlOf,
  concat,
  hexOf,
  textOf,
  utf8,
} from "./encoding.ts";

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const importAes = async (key: Uint8Array, usages: string[]): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", key, "AES-GCM", false, usages);

export const subscriptionIdOf = async (secret: Uint8Array): Promise<string> =>
  hexOf(await crypto.subtle.digest("SHA-256", concat(utf8(PUSH_ID_DOMAIN), secret))).slice(0, 32);

export const eventIdOf = async (
  key: Uint8Array,
  network: string,
  hash: string,
  kind: PushEventKind,
  generation: number,
): Promise<string> => {
  const hmac = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const input = utf8(pushEventInput(network, hash, kind, generation));
  return hexOf(await crypto.subtle.sign("HMAC", hmac, input)).slice(0, 32);
};

/** `base64url(nonce ‖ AES-256-GCM(key, nonce, plaintext, aad = PUSH_AAD_PREFIX ‖ eventId))`. */
export const sealEvent = async (
  key: Uint8Array,
  eventId: string,
  plaintext: string,
  nonce: Uint8Array,
): Promise<string> => {
  const aes = await importAes(key, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: utf8(pushAad(eventId)),
    },
    aes,
    utf8(plaintext),
  );
  return base64urlOf(concat(nonce, new Uint8Array(sealed)));
};

/** The subscription's dispatch envelope: platform, device token and payload key. */
export type SealedTarget = {
  readonly p: PushPlatform;
  readonly t: string;
  readonly k: string;
};

const targetAad = (family: PushFamily, id: string): Uint8Array => utf8(`${family}/${id}`);

/** AES-GCM under `PUSH_SEAL_KEY`, bound to `family/id` so a blob opens only where it was written. */
export const sealTarget = async (
  sealKey: CryptoKey,
  family: PushFamily,
  id: string,
  target: SealedTarget,
  nonce: Uint8Array,
): Promise<string> => {
  const plaintext = JSON.stringify({ p: target.p, t: target.t, k: target.k });
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: targetAad(family, id),
    },
    sealKey,
    utf8(plaintext),
  );
  return base64urlOf(concat(nonce, new Uint8Array(sealed)));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlatform = (value: unknown): value is PushPlatform =>
  (PUSH_PLATFORMS as ReadonlyArray<unknown>).includes(value);

/**
 * Opens a sealed target for exactly `family`/`id`; every failure — encoding, authentication or
 * shape — yields `undefined`, never a throw. The stored document carries exactly `{p, t, k}`.
 */
export const openTarget = async (
  sealKey: CryptoKey,
  family: PushFamily,
  id: string,
  sealed: string,
): Promise<SealedTarget | undefined> => {
  const blob = base64urlBytes(sealed);
  if (blob === undefined || blob.length < NONCE_LENGTH + TAG_LENGTH + 1) {
    return undefined;
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.slice(0, NONCE_LENGTH),
        additionalData: targetAad(family, id),
      },
      sealKey,
      blob.slice(NONCE_LENGTH),
    );
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(textOf(plaintext));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { p, t, k } = value;
  if (
    Object.keys(value).length !== 3 ||
    !isPlatform(p) ||
    typeof t !== "string" ||
    typeof k !== "string" ||
    !accepts(pushSecret, k)
  ) {
    return undefined;
  }
  return { p, t, k };
};

/**
 * `PUSH_SEAL_KEY` is 32 bytes of standard base64; anything else is a startup misconfiguration and
 * throws rather than failing later inside an alarm.
 */
export const importSealKey = async (base64: string): Promise<CryptoKey> => {
  const bytes = base64Bytes(base64);
  if (bytes === undefined || bytes.length !== KEY_LENGTH) {
    throw new Error("PUSH_SEAL_KEY must be 32 bytes of standard base64");
  }
  return importAes(bytes, ["encrypt", "decrypt"]);
};
