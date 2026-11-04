import { createEventVerifier, Keys, KeysSigner } from "@qntx/nostr";
import type { Event, NostrBackend, UnsignedEvent } from "@qntx/nostr";
import { nsecEncode } from "@qntx/nostr/nips/nip19";
import { encrypt as nip49Encrypt } from "@qntx/nostr/nips/nip49";
import { isGiftWrapKind, unwrap as nip59Unwrap } from "@qntx/nostr/nips/nip59";
import type { Rumor } from "@qntx/nostr/nips/nip59";
import type { UnwrapResult } from "@qntx/wallet/protocol";
import type { WalletErrorCode } from "@qntx/wallet/types";

import { KernelError } from "../../errors.ts";
import { decodeUtf8Secret, wipe } from "../../secret/secret.ts";

/**
 * Signer pool: one KeysSigner per nostr-key record, keyed by public key. Built at unlock from the
 * authenticated record plaintexts; disposed at lock so secrets die with the session.
 */
export class SignerPool {
  private readonly signers = new Map<string, KeysSigner>();
  private readonly backend: NostrBackend;

  constructor(backend: NostrBackend) {
    this.backend = backend;
  }

  /**
   * Takes ownership of `secretKey` and wipes it after the signer is constructed. A same-key replace
   * (reconciliation reclaims a changed record) disposes the signer it evicts.
   */
  add(secretKey: Uint8Array): string {
    try {
      const signer = new KeysSigner(Keys.fromSecretKey(secretKey, this.backend), {
        backend: this.backend,
      });
      const { publicKey } = signer.keys;
      this.signers.get(publicKey)?.dispose();
      this.signers.set(publicKey, signer);
      return publicKey;
    } finally {
      wipe(secretKey);
    }
  }

  get(publicKey: string): KeysSigner {
    const signer = this.signers.get(publicKey);
    if (signer === undefined) {
      throw new KernelError("not-found", "no such nostr key");
    }
    return signer;
  }

  remove(publicKey: string): void {
    const signer = this.signers.get(publicKey);
    if (signer !== undefined) {
      signer.dispose();
      this.signers.delete(publicKey);
    }
  }

  dispose(): void {
    for (const signer of this.signers.values()) {
      signer.dispose();
    }
    this.signers.clear();
  }
}

/** A fresh valid secp256k1 scalar from the platform RNG (retries on the ~2^-128 invalid draws). */

/** Decodes a UTF-8 `nsec1…` bech32 payload; the input bytes are wiped. */

/**
 * Decrypts an `ncryptsec` with the UTF-8 `password` bytes (wiped after use). The payload is decoded
 * and shape-checked before scrypt ever runs: malformed input is `invalid-input`, a logN above
 * `maxLogN` (the kernel policy's cap) is `unsupported`, a scrypt allocation failure (`RangeError`
 * cause) is `unavailable`, and every other decrypt failure is `wrong-password`. `scrypt` is a
 * kernel-internal test seam — hosts never inject it.
 */

export function nsecFromSecretKey(secretKey: Uint8Array): Uint8Array {
  return new TextEncoder().encode(nsecEncode(secretKey));
}

/**
 * Export `ncryptsec` at logN 16 with key security byte 0x02 ("the client does not track this" in
 * NIP-49's terms): the kernel does not track a key's handling history and any key can be exported
 * as plaintext nsec, so 0x01 would never be honest. `nip49Encrypt` draws its salt and nonce from
 * `crypto.getRandomValues`, which the kernel runtime installs natively (the same source as
 * `__qntx.random`; in a Web Worker, the platform CSPRNG), so no API-level injection is needed.
 */
export async function ncryptsecFromSecretKey(
  secretKey: Uint8Array,
  password: Uint8Array,
): Promise<Uint8Array> {
  const text = decodeUtf8Secret(password); // wipes `password`
  const encoded = await nip49Encrypt(secretKey, text, { logn: 16, ksb: 0x02 });
  return new TextEncoder().encode(encoded);
}

/** Validates the host-supplied pubkey hint and signs. Everything else is pre-validated. */
export async function signEvent(
  pool: SignerPool,
  publicKey: string,
  event: {
    readonly kind: number;
    readonly created_at: number;
    readonly tags: ReadonlyArray<ReadonlyArray<string>>;
    readonly content: string;
    readonly pubkey?: string;
  },
): Promise<Event> {
  if (event.pubkey !== undefined && event.pubkey !== publicKey) {
    throw new KernelError("invalid-input", "event pubkey does not match the selected key");
  }
  const unsigned: UnsignedEvent = {
    pubkey: publicKey,
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags,
    content: event.content,
  };
  return pool.get(publicKey).signEvent(unsigned);
}

/** Per-item unwrap: malformed gift wraps are isolated failures, never aborts. */
export async function unwrapGiftWrap(
  pool: SignerPool,
  publicKey: string,
  event: Event,
  backend: NostrBackend,
): Promise<UnwrapResult> {
  if (!isGiftWrapKind(event.kind)) {
    return { err: "invalid-input" };
  }
  try {
    const rumor: Rumor = await nip59Unwrap(pool.get(publicKey), event, {
      verify: createEventVerifier(backend),
    });
    return { ok: rumor };
  } catch (error) {
    const err: WalletErrorCode = error instanceof KernelError ? error.code : "integrity";
    return { err };
  }
}
