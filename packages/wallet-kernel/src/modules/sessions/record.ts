/**
 * The `session-key` record: one sealed secp256k1 private key per record, keyed by the key's
 * lowercase EVM address. The record format itself fixes the secp256k1 key, the id and the 32-byte
 * plaintext — independent of the scheme; the scheme only decides what the key signs. The header is
 * the authenticated public side — the scheme id, the wallet and account it belongs to, the scheme's
 * scope, the name the user gave it, and the signing deadline. A distinct kind, not a `key` record
 * with a scope flag: every path that enumerates `key` records (chain.sign imported pass,
 * keys.list/export/remove, backups) structurally cannot see it.
 */
import { isProtocolValue } from "@qntx/wallet/protocol";
import type { ProtocolValue } from "@qntx/wallet/protocol";

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

/* `limits` and `spent` sit in the header of every metered record this kernel seals — both are the
   scheme's canonical JSON objects (the approved limits and the charged metering). They stay
   optional on parse: records of schemes this build does not know, and of schemes that declare no
   metering, may carry neither. A metered scheme's record without them is `integrity` where the
   sessions handlers use it — this kernel seals metered records only with both. The scheme's own
   strict validators — limits at create, both at every read — are what give the objects meaning;
   here they only need to be plain JSON objects so a sealed record always parses. */

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
  /** The scheme's approved limits as a plain JSON object — the scheme itself revalidates it. */
  readonly limits?: ProtocolValue;
  /** The metering already charged against `limits` — a plain JSON object like `limits`. */
  readonly spent?: ProtocolValue;
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

const HEADER_OPTIONAL = ["limits", "spent"] as const;

const plainObject = (value: unknown): value is ProtocolValue =>
  isProtocolValue(value) &&
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

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
  const fields: Record<string, unknown> = {
    scheme: header.scheme,
    walletId: header.walletId,
    groupIndex: header.groupIndex,
    owner: header.owner,
    scope: header.scope,
    name: header.name,
    validUntil: header.validUntil,
    createdAt: header.createdAt,
  };
  if (header.limits !== undefined) {
    fields["limits"] = header.limits;
  }
  if (header.spent !== undefined) {
    fields["spent"] = header.spent;
  }
  return JSON.stringify(fields);
}

export function parseSessionHeader(text: string): SessionHeader {
  const object = headerObject(text);
  const optional = HEADER_OPTIONAL.filter((key) => Object.hasOwn(object, key));
  expectKeys(object, [...HEADER_KEYS, ...optional]);
  const header: {
    -readonly [K in keyof SessionHeader]?: SessionHeader[K];
  } = {
    scheme: asField(SCHEME)(object["scheme"]),
    walletId: asWalletId(object["walletId"]),
    groupIndex: asGroupIndex(object["groupIndex"]),
    owner: asField(OWNER)(object["owner"]),
    scope: asField(SCOPE)(object["scope"]),
    name: asField(NAME)(object["name"]),
    validUntil: asCreatedAt(object["validUntil"]),
    createdAt: asCreatedAt(object["createdAt"]),
  };
  const { limits, spent } = object;
  if (limits !== undefined) {
    if (!plainObject(limits)) {
      throw headerFailure();
    }
    header.limits = limits;
  }
  if (spent !== undefined) {
    if (!plainObject(spent)) {
      throw headerFailure();
    }
    header.spent = spent;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- required fields are set above
  return header as SessionHeader;
}

/** The stored session-key record for an address (any case), or undefined — never throws. */
export function findSession(image: VaultImage, address: string): StoredRecord | undefined {
  const id = address.toLowerCase();
  return image.records.find((record) => record.kind === SESSION_KIND && record.id === id);
}
