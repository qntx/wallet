import { utf8ToBytes } from "@noble/hashes/utils.js";

import { KernelError } from "../errors.ts";
import { decodeUtf8Secret } from "../secret/secret.ts";
import { MAX_PASSPHRASE_BYTES } from "../vault/vault.ts";

/**
 * A wire passphrase (raw UTF-8, wiped here) as the bytes the vault stores: NFKD-normalized, never
 * trimmed — spaces are significant in BIP-39 — and 1–1024 bytes after normalization.
 */
export function normalizePassphrase(wire: Uint8Array): Uint8Array {
  const normalized = utf8ToBytes(decodeUtf8Secret(wire).normalize("NFKD"));
  if (normalized.length === 0 || normalized.length > MAX_PASSPHRASE_BYTES) {
    normalized.fill(0);
    throw new KernelError("invalid-input", "passphrase must be 1-1024 bytes");
  }
  return normalized;
}

/** The text `seedFromMnemonic` takes for stored passphrase bytes (`undefined` → no passphrase). */
export function passphraseText(passphrase: Uint8Array | undefined): string {
  if (passphrase === undefined) {
    return "";
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(passphrase);
  } catch {
    throw new KernelError("integrity", "wallet passphrase is not valid UTF-8");
  }
}
