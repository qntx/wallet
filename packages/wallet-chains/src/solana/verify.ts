/**
 * Ed25519 signature verification for `chain.sign` results: the host checks the kernel's 64-byte
 * signature against the message and the account address returned by `wallet.accounts` — a wrong
 * signer fails closed.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { address, getAddressEncoder } from "@solana/addresses";

/** Whether `signature` is a valid ed25519 signature of `message` by the key behind `address`. */
export const verifySolanaSignature = (
  message: Uint8Array,
  signature: Uint8Array,
  accountAddress: string,
): boolean => {
  if (signature.length !== 64) {
    return false;
  }
  try {
    return ed25519.verify(
      signature,
      message,
      new Uint8Array(getAddressEncoder().encode(address(accountAddress))),
    );
  } catch {
    return false;
  }
};
