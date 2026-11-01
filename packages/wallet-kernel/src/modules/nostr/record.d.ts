import type { NostrKeyInfo } from "@qntx/wallet/types";
import type { StoredRecord } from "../../vault/store.ts";
/** The record kind this module owns: one sealed nostr secret key per record, keyed by public key. */
export declare const NOSTR_KEY_KIND = "nostr-key";
/**
 * `backedUp` exists only on standalone keys (nsec/ncryptsec/generated): they have no parent wallet
 * to recover from, so the header tracks whether the user has exported the key. Derived and
 * nip46-client headers must not carry it.
 */
export type NostrKeyHeader = {
    readonly publicKey: string;
    readonly origin: "derived";
    readonly walletId: string;
    readonly groupIndex: number;
    readonly createdAt: number;
} | {
    readonly publicKey: string;
    readonly origin: "nsec" | "ncryptsec" | "generated";
    readonly backedUp: boolean;
    readonly createdAt: number;
} | {
    readonly publicKey: string;
    readonly origin: "nip46-client";
    readonly createdAt: number;
};
export declare function encodeNostrKeyHeader(header: NostrKeyHeader): string;
export declare function parseNostrKeyHeader(text: string): NostrKeyHeader;
/** The `NostrKeyInfo` a nostr-key record's public header reports. */
export declare function nostrKeyInfo(header: NostrKeyHeader): NostrKeyInfo;
/**
 * The module's status section over the records it owns. A record whose header fails the strict
 * parser reports `corrupted` — the row is never silently dropped.
 */
export declare function nostrStatus(records: ReadonlyArray<StoredRecord>): {
    readonly keys: ReadonlyArray<NostrKeyInfo>;
    readonly corrupted: boolean;
};
