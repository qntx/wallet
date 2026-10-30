/**
 * /solana/sign — deterministic Ed25519 signing over the compiled message or raw offchain bytes.
 * Inputs must already be normalized: the kernel calls `normalizeSolana` first. No key caching; the
 * caller wipes key bytes.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

import { ChainError } from "../index.ts";

/** Signs `message` with a 32-byte Ed25519 seed; returns the 64-byte signature. */
export const signSolanaMessage = (message: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be a 32-byte seed");
  }
  if (message.length === 0) {
    throw new ChainError("invalid-request", "message must not be empty");
  }
  const signature = ed25519.sign(message, privateKey);
  if (signature.length !== 64) {
    throw new ChainError("invalid-request", "ed25519 produced a malformed signature");
  }
  return signature;
};
