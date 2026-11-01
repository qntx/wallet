import type { Factor } from "@qntx/wallet/protocol";
import type { FactorInfo, WalletInfo } from "@qntx/wallet/types";
import type { KernelPlatform, KeystorePrompt } from "../platform.ts";
import { Secret } from "../secret/secret.ts";
import type { EntropyHeader } from "./headers.ts";
import type { StoredFactor, StoredRecord, StoreOp, VaultImage } from "./store.ts";
export declare const PASSWORD_FACTOR_ITERATIONS = 600000;
/**
 * A new factor's KEK plus the public header material. The KEK is caller-owned (wipe it or hand it
 * to `Secret.take`); the password variant's raw `salt` must be wiped after encoding.
 */
export type FactorKekMaterial = {
    readonly kind: "password";
    readonly kek: Uint8Array;
    readonly salt: Uint8Array;
} | {
    readonly kind: "passkey";
    readonly kek: Uint8Array;
    readonly credentialId: Uint8Array;
} | {
    readonly kind: "hardware";
    readonly kek: Uint8Array;
    readonly sealedKek: Uint8Array;
};
export type SoftwareFactor = Exclude<Factor, {
    readonly kind: "hardware";
}>;
type SoftwareKekMaterial = Exclude<FactorKekMaterial, {
    readonly kind: "hardware";
}>;
type HardwareKekMaterial = Extract<FactorKekMaterial, {
    readonly kind: "hardware";
}>;
/**
 * The single "derive KEK for a new software factor" path, shared by `makeFactor` and mnemonic-draft
 * pending factors. The password policy applies only here: factor creation. `factor`'s secret bytes
 * are consumed (wiped) by the KDFs.
 */
export declare function newFactorKek(platform: KernelPlatform, factor: SoftwareFactor): Promise<SoftwareKekMaterial>;
/**
 * A hardware factor's KEK: 32 random bytes sealed by the platform keystore under key alias `id`
 * (the factor id). Only the sealed form is stored — in the public header, beside the X25519 key the
 * DEK wraps to, so rotation never needs a prompt.
 */
export declare function newHardwareKek(platform: KernelPlatform, id: string): Promise<HardwareKekMaterial>;
type FactorHeaderMaterial = {
    readonly kind: "password";
    readonly salt: Uint8Array;
} | {
    readonly kind: "passkey";
    readonly credentialId: Uint8Array;
} | {
    readonly kind: "hardware";
    readonly sealedKek: Uint8Array;
};
/** Public header text for a new factor (raw bytes → base64url). `publicKey` is not consumed. */
export declare function factorHeader(material: FactorHeaderMaterial, publicKey: Uint8Array, createdAt: number): string;
/**
 * The stored row for a factor whose KEK material exists: header with the KEK's public wrapping key,
 * the DEK wrapped to it. Wipes the material's KEK and password salt.
 */
export declare function factorRow(platform: KernelPlatform, material: FactorKekMaterial, id: string, dek: Secret): StoredFactor;
/** Builds a new factor record wrapping `dek`. The id comes first: it is the hardware key alias. */
export declare function makeFactor(platform: KernelPlatform, factor: Factor, dek: Secret): Promise<StoredFactor>;
/**
 * One record's authenticated plaintext from an unlock or reconcile pass. The vault layer opens
 * every record (AEAD bound to context plus the raw header) without interpreting kind or payload —
 * the composition point decides which module claims each plaintext and wipes the rest.
 */
export type OpenedRecord = {
    readonly kind: string;
    readonly id: string;
    readonly plaintext: Uint8Array;
};
/**
 * Unlocks the vault: factor unwrap against the caller-supplied fresh image. Returns the DEK and the
 * vault keyId for the session; record and factor authentication happens in the reconcile pass that
 * follows (every row is "new" to an empty live state).
 *
 * Password attempts are rate-limited on the stored counters: with no password factor the attempt is
 * `invalid-input` and never counted; an attempt rejected while backoff is armed is `rate-limited`
 * and never counted; a real miss commits `record-failure` through the given `commit` (atomic
 * against the shared store) and a success clears a nonzero counter with `reset-failures`. Passkey
 * and hardware unlock are never gated or counted — the platform rate-limits its own prompt.
 */
export declare function unlock(platform: KernelPlatform, image: VaultImage, factor: Factor, commit: (ops: ReadonlyArray<StoreOp>) => Promise<void>): Promise<{
    dek: Secret;
    keyId: string;
}>;
/**
 * Re-verifies a factor against the live session DEK: unwrap with the factor KEK and constant-time
 * compare. A public-key miss — `wrong-password`/`wrong-passkey` — tries the next candidate; every
 * other failure (including corruption-marked integrity) propagates immediately. When no candidate
 * matched, the miss is reported by factor kind: `wrong-password` (or `invalid-input` when no
 * password factor exists), `wrong-passkey`, or for hardware `factor-unavailable` (no hardware
 * factor) / `integrity` (the keystore opened a KEK for another DEK). `prompt` renders the system
 * verification text and runs only for hardware. The verify path never touches the rate limiter.
 */
export declare function verifyFactor(platform: KernelPlatform, image: VaultImage, factor: Factor, dek: Secret, prompt: () => KeystorePrompt): Promise<void>;
/**
 * Rotates the vault: a fresh DEK and keyId; every record re-sealed under the new DEK keeping its
 * public header; every retained factor re-wraps the new DEK to the public key of a row whose
 * binding verified under the current DEK (an unverified row is never re-wrapped — it latches
 * corrupted instead); added factors are built under the new DEK. One guarded commit lands it all:
 * `set-key-id`, `delete-factor`s, `put-factor`s, `put-record`s.
 *
 * Everything secret is wiped on failure; on success the caller hands `dek` to `ctx.commit(ops, {
 * rotate })` or wipes it.
 */
export declare function rotateVault(platform: KernelPlatform, image: VaultImage, dek: Secret, removed: ReadonlySet<string>, added: ReadonlyArray<Factor>): Promise<{
    ops: StoreOp[];
    dek: Secret;
    keyId: string;
    added: StoredFactor[];
}>;
export declare function sealRecord(platform: KernelPlatform, dek: Secret, kind: string, id: string, header: string, plaintext: Uint8Array): StoredRecord;
export declare function openRecord(dek: Secret, record: StoredRecord): Uint8Array;
export declare function findRecord(image: VaultImage, kind: string, id: string): StoredRecord;
/**
 * Ops that establish the vault in one atomic `init` commit, rejected by `conflict` if the store is
 * not empty. The caller keeps `keyId` for the session it opens afterwards.
 */
export declare function establishOps(platform: KernelPlatform, factor: StoredFactor, records: ReadonlyArray<StoredRecord>): {
    ops: StoreOp[];
    keyId: string;
};
/** The `FactorInfo` a stored factor reports: kind, id, creation time, passkey credentialId. */
export declare function factorInfo(stored: StoredFactor): FactorInfo;
/** The `WalletInfo` an entropy record's public header reports. */
export declare function walletInfo(header: EntropyHeader): WalletInfo;
export {};
