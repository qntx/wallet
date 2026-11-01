import type { VaultImage } from "./store.ts";
/**
 * Strict shape check for a vault image. Returns the input typed as VaultImage; throws KernelError
 * "integrity" on any structural violation so a tampered store fails closed. `meta.format` is
 * checked before anything else: a non-integer is integrity, a different format is "unsupported"
 * (data written by another build — left untouched).
 */
export declare function assertVaultImage(value: unknown): VaultImage;
/** The idle-timeout choices a host may request; the worker maps them to milliseconds. */
