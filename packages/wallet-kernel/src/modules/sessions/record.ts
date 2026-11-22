/**
 * The `session-key` record: one sealed secp256k1 private key per record, keyed by the key's
 * lowercase EVM address. The record format itself fixes the secp256k1 key, the id and the 32-byte
 * plaintext — independent of the scheme; the scheme only decides what the key signs. The header is
 * the authenticated public side — the scheme id, the wallet and account it belongs to, the scheme's
 * scope, the name the user gave it, and the signing deadline. A distinct kind, not a `key` record
 * with a scope flag: every path that enumerates `key` records (chain.sign imported pass,
 * keys.list/export/remove, backups) structurally cannot see it.
 */
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
export const SESSION_KIND = "session-key";

const SCHEME = /^[a-z][a-z0-9-]{1,31}$/;
const OWNER = /^0x[0-9a-fA-F]{40}$/;
const SCOPE = /^[A-Za-z0-9._:-]{1,64}$/;
const NAME = /^[A-Za-z0-9._-]{1,16}$/;

export type SessionHeader = {
  /** The scheme that decides what the key signs — an id this build may not know. */
  readonly scheme: string;
  readonly walletId: string;
  readonly groupIndex: number;
  /** EIP-55 owner address, derived by the kernel — never host input. */
  readonly owner: string;
  /** The scheme's opaque scope — its own parseScope gives it meaning. */
  readonly scope: string;
  readonly name: string;
  readonly validUntil: number;
  readonly createdAt: number;
};

const HEADER_KEYS = [
  "scheme",
  "walletId",
  "groupIndex",
  "owner",
  "scope",
  "name",
  "validUntil",
  "createdAt",
] as const;

const asField =
  (pattern: RegExp) =>
  (value: unknown): string => {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw headerFailure();
    }
    return value;
  };

/** Stored JSON, key order fixed so the text is a stable authenticated byte string. */
export function encodeSessionHeader(header: SessionHeader): string {
  return JSON.stringify({
    scheme: header.scheme,
    walletId: header.walletId,
    groupIndex: header.groupIndex,
    owner: header.owner,
    scope: header.scope,
    name: header.name,
    validUntil: header.validUntil,
    createdAt: header.createdAt,
  });
}

export function parseSessionHeader(text: string): SessionHeader {
  const object = headerObject(text);
  expectKeys(object, HEADER_KEYS);
  return {
    scheme: asField(SCHEME)(object["scheme"]),
    walletId: asWalletId(object["walletId"]),
    groupIndex: asGroupIndex(object["groupIndex"]),
    owner: asField(OWNER)(object["owner"]),
    scope: asField(SCOPE)(object["scope"]),
    name: asField(NAME)(object["name"]),
    validUntil: asCreatedAt(object["validUntil"]),
    createdAt: asCreatedAt(object["createdAt"]),
  };
}

/** The stored session-key record for an address (any case), or undefined — never throws. */
export function findSession(image: VaultImage, address: string): StoredRecord | undefined {
  const id = address.toLowerCase();
  return image.records.find((record) => record.kind === SESSION_KIND && record.id === id);
}
