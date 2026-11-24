/**
 * The digest guards every hardware signer shares: `personalDigest` recomputes the EIP-191
 * personal-message digest a kernel personal-message task was planned over, and `expectDigest`
 * requires a recomputed digest to equal the task's — `integrity` otherwise, so a kernel-side
 * planning fault can never produce a signature over bytes the user did not approve.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { KernelError } from "../../errors.ts";

/** The EIP-191 digest of `message` — what a personal-message task must equal. */
export const personalDigest = (message: Uint8Array): Uint8Array =>
  keccak_256(
    concatBytes(utf8ToBytes(`\u0019Ethereum Signed Message:\n${message.length}`), message),
  );

/** Requires `computed` to equal the task's planned digest — `integrity` otherwise. */
export const expectDigest = (computed: Uint8Array, task: { readonly digest: Uint8Array }): void => {
  if (!equalBytes(computed, task.digest)) {
    throw new KernelError("integrity", "malformed device sign exchange");
  }
};
