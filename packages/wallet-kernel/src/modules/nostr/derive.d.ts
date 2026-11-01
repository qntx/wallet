import type { HDKey } from "@scure/bip32";
/** NIP-06 private key of account group `groupIndex` (m/44'/1237'/i'/0/0). */
export declare function nostrKeyAt(master: HDKey, groupIndex: number): Uint8Array;
