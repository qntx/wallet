/**
 * Binds the native `__qntx.anchor` object to the kernel's `VaultAnchor` contract. The primitive is
 * synchronous — a few bytes in the platform keystore, read or compare-and-swapped under one
 * process-wide mutex — so the binding is only an async wrapper: a throw from the platform becomes a
 * rejection the kernel maps to `unavailable`.
 *
 * Imports go through relative source paths, never `@qntx/wallet-kernel`: the package is private and
 * cannot be declared, and this file is bundled into the kernel bytecode anyway.
 */
import type { VaultAnchor } from "../../wallet-kernel/src/platform.ts";

/** The `__qntx.anchor` surface the native host injects. */
export type KernelAnchorNative = {
  /** The stored record, or undefined when nothing is stored. Throws on a platform failure. */
  readonly read: () => Uint8Array | undefined;
  /**
   * Atomic compare-and-swap: writes `next` only when the stored bytes equal `expected` (undefined =
   * nothing stored). Returns false — writing nothing — when the stored bytes changed underneath.
   * Throws on a platform failure.
   */
  readonly replace: (next: Uint8Array, expected: Uint8Array | undefined) => boolean;
};

export function bindNativeAnchor(raw: KernelAnchorNative): VaultAnchor {
  return {
    // oxlint-disable-next-line typescript/require-await -- errors must reject, not throw synchronously
    async read() {
      return raw.read();
    },
    // oxlint-disable-next-line typescript/require-await -- errors must reject, not throw synchronously
    async replace(next, expected) {
      return raw.replace(next, expected);
    },
  };
}
