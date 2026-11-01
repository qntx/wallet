import type { BackupEnvelopeFactor } from "@qntx/wallet/protocol";
/**
 * The core-owned public headers: `entropy` and `data-key` records plus the two factor kinds.
 * Module-owned record kinds keep their parsers inside their module.
 */
export type EntropyHeader = {
    readonly walletId: string;
    readonly origin: "passkey" | "mnemonic";
    readonly words: 12 | 15 | 18 | 21 | 24;
    /** How the entropy survives this device: nothing, a synced passkey, or a written-down mnemonic. */
    readonly backup: "none" | "passkey" | "mnemonic";
    readonly createdAt: number;
};
export type DataKeyHeader = {
    readonly purpose: string;
    readonly createdAt: number;
};
export type PasswordFactorHeader = {
    readonly salt: string;
    readonly iterations: 600000;
    readonly publicKey: string;
    readonly createdAt: number;
};
export type PasskeyFactorHeader = {
    readonly credentialId: string;
    readonly publicKey: string;
    readonly createdAt: number;
};
export type HardwareFactorHeader = {
    /** Base64url (no padding), decodes to 1–512 bytes — the keystore-sealed KEK. */
    readonly sealedKek: string;
    readonly publicKey: string;
    readonly createdAt: number;
};
export type BackupKeyHeader = {
    /** 32 lowercase hex — HKDF over the BEK; never the BEK itself. */
    readonly id: string;
    readonly factors: ReadonlyArray<BackupEnvelopeFactor>;
    readonly createdAt: number;
};
export type CoreHeader = EntropyHeader | DataKeyHeader | PasswordFactorHeader | PasskeyFactorHeader | HardwareFactorHeader | BackupKeyHeader;
export declare function encodeHeader(header: CoreHeader): string;
export declare function parseEntropyHeader(text: string): EntropyHeader;
export declare function parseDataKeyHeader(text: string): DataKeyHeader;
export declare function parsePasswordFactorHeader(text: string): PasswordFactorHeader;
export declare function parsePasskeyFactorHeader(text: string): PasskeyFactorHeader;
export declare function parseHardwareFactorHeader(text: string): HardwareFactorHeader;
export declare function parseBackupKeyHeader(text: string): BackupKeyHeader;
