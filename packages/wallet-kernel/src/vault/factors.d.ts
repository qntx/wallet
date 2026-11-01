import type { Pbkdf2, Random } from "../platform.ts";
import { Secret } from "../secret/secret.ts";
import type { StoredFactor } from "./store.ts";
/**
 * Policy for a password factor at creation time: at least 10 Unicode code points after NFKC. Never
 * applied at unlock — a failing password there is just a wrong-password attempt.
 */
export declare function assertPasswordPolicy(password: Uint8Array): void;
/**
 * Password factor KEK: PBKDF2-HMAC-SHA256(UTF-8(NFKC(password)), salt, 600000, 32). The password
 * arrives as UTF-8 bytes (protocol rule) and is wiped afterwards.
 */
export declare function passwordKek(password: Uint8Array, salt: Uint8Array, pbkdf2: Pbkdf2): Promise<Uint8Array>;
/**
 * Passkey factor KEK: HKDF-SHA256(ikm = prf, salt = credentialId, info =
 * "qntx-wallet/kek/passkey/v1", 32). Wipes `prf` in every case.
 */
export declare function passkeyKek(prf: Uint8Array, credentialId: Uint8Array): Uint8Array;
/** The factor's public wrapping key: X25519(HKDF-SHA256(KEK)). Public — safe to store in headers. */
export declare function factorPublicKey(kek: Uint8Array): Uint8Array;
/** The `publicKey` a factor header declares, decoded; malformed headers throw `integrity`. */
export declare function factorHeaderPublicKey(stored: StoredFactor): Uint8Array;
/**
 * Whether the stored factor row binds `dek` — structure check plus the HMAC tag. No KEK is needed:
 * the tag proves the row was written for this DEK by someone who held it.
 */
export declare function factorBindingOk(dek: Secret, stored: StoredFactor): boolean;
export type FactorRef = {
    readonly kind: StoredFactor["kind"];
    readonly id: string;
    readonly header: string;
};
/**
 * Seals the DEK to a factor's public key — no KEK needed, so rotation can re-wrap to factors it
 * cannot unlock. `factorPk` is the 32-byte X25519 public key from the factor's header.
 */
export declare function wrapDek(dek: Secret, factorPk: Uint8Array, factor: FactorRef, random: Random): Uint8Array;
/**
 * Opens a stored factor's wrapped DEK. A KEK that does not belong to this factor fails the cheap
 * public-key check before any AEAD runs — `wrong-password` for password factors (the counter
 * decides what it means), `wrong-passkey` for passkeys. A row whose structure, ciphertext or
 * binding is broken reports `integrity` marked corrupted.
 */
export declare function unwrapDek(kek: Uint8Array, stored: StoredFactor): Secret;
