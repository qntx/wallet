/**
 * Binds the native `__qntx.backends.nostr` object to the `NostrBackend` contract. The ABI version
 * is pinned to NOSTR_NATIVE_ABI_VERSION in nostr-native's include/nostr_native.h: a mismatch means
 * the linked libNostrNative predates or postdates this kernel — an `integrity` failure, never a
 * load. `nostr_native:` errors from the C++ side map back to `CryptoError`; every other error
 * passes through. verifySerialized answers with a boolean like nobleBackend.
 */
import { CryptoError } from "@qntx/nostr";
import type { NostrBackend } from "@qntx/nostr";

import { KernelError } from "../../wallet-kernel/src/errors.ts";

/** Mirrors NOSTR_NATIVE_ABI_VERSION in nostr-native's include/nostr_native.h. */
export const NOSTR_NATIVE_ABI_VERSION = 2;

/** The `__qntx.backends.nostr` surface the native host injects. */
export type KernelNostrNative = {
  readonly abiVersion: number;
  readonly publicKey: (secretKey: Uint8Array) => Uint8Array;
  readonly sign: (id: Uint8Array, secretKey: Uint8Array, auxRand: Uint8Array) => Uint8Array;
  readonly verifySerialized: (
    serializedUtf8: Uint8Array,
    id: Uint8Array,
    pubkey: Uint8Array,
    sig: Uint8Array,
  ) => boolean;
  readonly ecdhX: (secretKey: Uint8Array, publicKeyX: Uint8Array) => Uint8Array;
};

function call<T>(invoke: () => T): T {
  try {
    return invoke();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("nostr_native:")) {
      throw new CryptoError(error.message, { cause: error });
    }
    throw error;
  }
}

export function bindNativeNostr(raw: KernelNostrNative): NostrBackend {
  if (raw.abiVersion !== NOSTR_NATIVE_ABI_VERSION) {
    throw new KernelError(
      "integrity",
      `nostr-native ABI version ${raw.abiVersion} does not match NOSTR_NATIVE_ABI_VERSION ${NOSTR_NATIVE_ABI_VERSION}`,
    );
  }
  return {
    publicKey: (secretKey) => call(() => raw.publicKey(secretKey)),
    sign: (id, secretKey, auxRand) => call(() => raw.sign(id, secretKey, auxRand)),
    verifySerialized: (serializedUtf8, id, pubkey, sig) =>
      raw.verifySerialized(serializedUtf8, id, pubkey, sig),
    ecdhX: (secretKey, publicKeyX) => call(() => raw.ecdhX(secretKey, publicKeyX)),
  };
}
