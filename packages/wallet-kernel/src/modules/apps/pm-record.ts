/**
 * The `pm-creds` record: one sealed Polymarket CLOB L2 credential set per HD group, keyed
 * `${walletId}.${groupIndex}` — importing again for the same group overwrites. The header is the
 * authenticated public side: the wallet and group the credentials belong to, the kernel-derived
 * owner address, the public apiKey, and createdAt. The plaintext is UTF-8 JSON with exactly
 * `{"secret","passphrase"}`; the secret never leaves a record's opened lifetime — signL2 opens it,
 * computes the HMAC and wipes.
 *
 * A distinct kind, not a `key` record with a scope flag: every path that enumerates `key` records
 * (chain.sign imported pass, keys.list/export/remove, backups) structurally cannot see it.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import {
  asCreatedAt,
  asGroupIndex,
  asWalletId,
  expectKeys,
  headerFailure,
  headerObject,
} from "../../vault/header-codec.ts";
import type { StoredRecord, VaultImage } from "../../vault/store.ts";

/** The record kind this module owns. */
export const PM_CREDS_KIND = "pm-creds";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const API_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The alphabet import accepts — standard or url-safe base64, padding optional. */
const SECRET_CHARS = /^[A-Za-z0-9+/=_-]+$/;
/** Printable ASCII 0x21–0x7e, like the CLOB issues it. */
const PASSPHRASE = /^[\u0021-\u007E]{1,128}$/;

/** Bounds for the stored credential fields; the params layer mirrors them. */
export const SECRET_MAX_CHARS = 128;
export const PASSPHRASE_MAX_CHARS = 128;
const SECRET_MIN_BYTES = 16;
const SECRET_MAX_BYTES = 64;

export type CredentialsHeader = {
  readonly walletId: string;
  readonly groupIndex: number;
  /** EIP-55 owner address, derived by the kernel — never host input. */
  readonly owner: string;
  /** The lowercase UUID the CLOB issued with this credential set. */
  readonly apiKey: string;
  readonly createdAt: number;
};

/** What a record's plaintext decodes to — the secret stays a string, decoded only inside signL2. */
export type CredentialsPlaintext = {
  readonly secret: string;
  readonly passphrase: string;
};

const HEADER_KEYS = ["walletId", "groupIndex", "owner", "apiKey", "createdAt"] as const;

const asAddress = (value: unknown): string => {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw headerFailure();
  }
  return value;
};

const asApiKey = (value: unknown): string => {
  if (typeof value !== "string" || !API_KEY.test(value)) {
    throw headerFailure();
  }
  return value;
};

/** Stored JSON, key order fixed so the text is a stable authenticated byte string. */
export function encodeCredentialsHeader(header: CredentialsHeader): string {
  return JSON.stringify({
    walletId: header.walletId,
    groupIndex: header.groupIndex,
    owner: header.owner,
    apiKey: header.apiKey,
    createdAt: header.createdAt,
  });
}

export function parseCredentialsHeader(text: string): CredentialsHeader {
  const object = headerObject(text);
  expectKeys(object, HEADER_KEYS);
  return {
    walletId: asWalletId(object["walletId"]),
    groupIndex: asGroupIndex(object["groupIndex"]),
    owner: asAddress(object["owner"]),
    apiKey: asApiKey(object["apiKey"]),
    createdAt: asCreatedAt(object["createdAt"]),
  };
}

/**
 * The secret decoded to HMAC key bytes, or undefined when the string is not within bounds or does
 * not decode. Mirrors clob-client-v2 `src/signing/hmac.ts` `decodeBase64Secret`: the url-safe
 * alphabet is normalized to the standard one and `=` padding is optional; a length-`%4 == 1`
 * remainder or a stray `=` fails the decode, never produces wrong bytes.
 */
export function decodeSecret(secret: string): Uint8Array | undefined {
  if (secret.length === 0 || secret.length > SECRET_MAX_CHARS || !SECRET_CHARS.test(secret)) {
    return undefined;
  }
  const normalized = secret.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bytes = base64.decode(padded);
    return bytes.length >= SECRET_MIN_BYTES && bytes.length <= SECRET_MAX_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sealed record whose plaintext does not parse is corruption by construction: AEAD already proved
 * the store authentic, so the bytes were written malformed — latch it.
 */
const plaintextFailure = (): KernelError =>
  new KernelError("integrity", "invalid pm-creds plaintext", undefined, true);

/** The stored plaintext: exactly `{"secret":…,"passphrase":…}` in this key order. */
export function encodeCredentialsPlaintext(credentials: CredentialsPlaintext): Uint8Array {
  return utf8ToBytes(
    JSON.stringify({ secret: credentials.secret, passphrase: credentials.passphrase }),
  );
}

/**
 * Strict plaintext validation shared by claimUnlocked, signL2 and import: exactly the two keys,
 * both strings, a secret that decodes to 16–64 bytes, a printable passphrase. Every failure is a
 * KernelError (callers latch it as corruption or answer invalid-input) — never a raw throw.
 */
export function parseCredentialsPlaintext(plaintext: Uint8Array): CredentialsPlaintext {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    value = JSON.parse(text) as unknown;
  } catch {
    throw plaintextFailure();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw plaintextFailure();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-array object above
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(object, "secret") ||
    !Object.hasOwn(object, "passphrase")
  ) {
    throw plaintextFailure();
  }
  const { secret, passphrase } = object;
  const key = typeof secret === "string" ? decodeSecret(secret) : undefined;
  try {
    if (key === undefined || typeof passphrase !== "string" || !PASSPHRASE.test(passphrase)) {
      throw plaintextFailure();
    }
  } finally {
    if (key !== undefined) {
      wipe(key);
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- both fields were just narrowed
  return object as unknown as CredentialsPlaintext;
}

/** The record id a group owns: `${walletId}.${groupIndex}` — one credential set per group. */
export function credsRecordId(owner: {
  readonly walletId: string;
  readonly groupIndex: number;
}): string {
  return `${owner.walletId}.${owner.groupIndex}`;
}

/** The stored pm-creds record for a group, or undefined — never throws. */
export function findCreds(
  image: VaultImage,
  owner: { readonly walletId: string; readonly groupIndex: number },
): StoredRecord | undefined {
  const id = credsRecordId(owner);
  return image.records.find((record) => record.kind === PM_CREDS_KIND && record.id === id);
}
