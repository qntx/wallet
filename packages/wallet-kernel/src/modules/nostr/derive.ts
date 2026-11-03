import type { HDKey } from "@scure/bip32";

import { KernelError } from "../../errors.ts";

/** The NIP-06 derivation path; `i` is the identity index segment. */
const NIP06_PATH = "m/44'/1237'/i'/0/0";

/**
 * NIP-06 private key of identity index `index` (m/44'/1237'/i'/0/0). The full 31-bit range is legal
 * here: identity indices stop at 0x7ffffffe and the highest segment derives the wallet sync key.
 */
export function nostrKeyAt(master: HDKey, index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new KernelError("invalid-input", "identity index out of range");
  }
  const path = NIP06_PATH.split("/")
    .map((segment) => (segment === "i'" ? `${index}'` : segment))
    .join("/");
  const node = master.derive(path);
  try {
    const key = node.privateKey;
    if (key === null || key.length !== 32) {
      throw new KernelError("integrity", "derived node has no private key");
    }
    return Uint8Array.from(key);
  } finally {
    node.wipePrivateData();
  }
}
