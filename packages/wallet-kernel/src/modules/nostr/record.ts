import type { NostrKeyInfo } from "@qntx/wallet/types";

import {
  asCreatedAt,
  asIdentityIndex,
  asPublicKey,
  asWalletId,
  expectKeys,
  headerObject,
} from "../../vault/header-codec.ts";
import type { StoredRecord } from "../../vault/store.ts";

/** The record kind this module owns: one sealed nostr secret key per record, keyed by public key. */
export const NOSTR_KEY_KIND = "nostr-key";

/** A seed-derived identity: the public key plus the wallet and identity index it re-derives from. */
export type NostrKeyHeader = {
  readonly publicKey: string; // 64 lowercase hex
  readonly walletId: string;
  readonly index: number;
  readonly createdAt: number;
};

export function encodeNostrKeyHeader(header: NostrKeyHeader): string {
  return JSON.stringify({
    publicKey: header.publicKey,
    walletId: header.walletId,
    index: header.index,
    createdAt: header.createdAt,
  });
}

export function parseNostrKeyHeader(text: string): NostrKeyHeader {
  const object = headerObject(text);
  expectKeys(object, ["publicKey", "walletId", "index", "createdAt"]);
  return {
    publicKey: asPublicKey(object["publicKey"]),
    walletId: asWalletId(object["walletId"]),
    index: asIdentityIndex(object["index"]),
    createdAt: asCreatedAt(object["createdAt"]),
  };
}

/** The `NostrKeyInfo` a nostr-key record's public header reports. */
export function nostrKeyInfo(header: NostrKeyHeader): NostrKeyInfo {
  return {
    ref: { kind: "derived", walletId: header.walletId, index: header.index },
    publicKey: header.publicKey,
    createdAt: header.createdAt,
  };
}

/** The `nostr.keys` section of the status snapshot — one `NostrKeyInfo` per owned record. */
export function nostrStatus(records: ReadonlyArray<StoredRecord>): {
  keys: ReadonlyArray<NostrKeyInfo>;
  corrupted: boolean;
} {
  const keys: NostrKeyInfo[] = [];
  let corrupted = false;
  for (const record of records) {
    if (record.kind === NOSTR_KEY_KIND) {
      try {
        keys.push(nostrKeyInfo(parseNostrKeyHeader(record.header)));
      } catch {
        corrupted = true;
      }
    }
  }
  return { keys, corrupted };
}
