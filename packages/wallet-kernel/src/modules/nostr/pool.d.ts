import { KeysSigner } from "@qntx/nostr";
import type { Event, NostrBackend } from "@qntx/nostr";
import type { Scrypt } from "@qntx/nostr/nips/nip49";
import type { UnwrapResult } from "@qntx/wallet/protocol";
import type { KernelPlatform } from "../../platform.ts";
/**
 * Signer pool: one KeysSigner per nostr-key record, keyed by public key. Built at unlock from the
 * authenticated record plaintexts; disposed at lock so secrets die with the session.
 */
export declare class SignerPool {
    private readonly signers;
    private readonly backend;
    constructor(backend: NostrBackend);
    /**
     * Takes ownership of `secretKey` and wipes it after the signer is constructed. A same-key replace
     * (reconciliation reclaims a changed record) disposes the signer it evicts.
     */
    add(secretKey: Uint8Array): string;
    get(publicKey: string): KeysSigner;
    remove(publicKey: string): void;
    dispose(): void;
}
/** A fresh valid secp256k1 scalar from the platform RNG (retries on the ~2^-128 invalid draws). */
export declare function generateSecretKey(random: KernelPlatform["random"], backend: NostrBackend): Uint8Array;
/** Decodes a UTF-8 `nsec1…` bech32 payload; the input bytes are wiped. */
export declare function secretKeyFromNsec(nsec: Uint8Array): Uint8Array;
/**
 * Decrypts an `ncryptsec` with the UTF-8 `password` bytes (wiped after use). The payload is decoded
 * and shape-checked before scrypt ever runs: malformed input is `invalid-input`, a logN above
 * `maxLogN` (the kernel policy's cap) is `unsupported`, a scrypt allocation failure (`RangeError`
 * cause) is `unavailable`, and every other decrypt failure is `wrong-password`. `scrypt` is a
 * kernel-internal test seam — hosts never inject it.
 */
export declare function secretKeyFromNcryptsec(ncryptsec: string, password: Uint8Array, maxLogN: number, scrypt?: Scrypt): Promise<Uint8Array>;
export declare function nsecFromSecretKey(secretKey: Uint8Array): Uint8Array;
/**
 * Export `ncryptsec` at logN 16 with key security byte 0x02 ("the client does not track this" in
 * NIP-49's terms): the kernel does not track a key's handling history and any key can be exported
 * as plaintext nsec, so 0x01 would never be honest. Salt and nonce come from the library's RNG
 * (noble randomBytes); not injectable in 0.14.
 */
export declare function ncryptsecFromSecretKey(secretKey: Uint8Array, password: Uint8Array): Promise<Uint8Array>;
/** Validates the host-supplied pubkey hint and signs. Everything else is pre-validated. */
export declare function signEvent(pool: SignerPool, publicKey: string, event: {
    readonly kind: number;
    readonly created_at: number;
    readonly tags: ReadonlyArray<ReadonlyArray<string>>;
    readonly content: string;
    readonly pubkey?: string;
}): Promise<Event>;
/** Per-item unwrap: malformed gift wraps are isolated failures, never aborts. */
export declare function unwrapGiftWrap(pool: SignerPool, publicKey: string, event: Event, backend: NostrBackend): Promise<UnwrapResult>;
