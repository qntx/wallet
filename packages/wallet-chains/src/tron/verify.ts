/**
 * Secp256k1 signature recovery and verification for `chain.sign` results: the host checks the
 * kernel's 65-byte signature against the payload and the account address returned by
 * `wallet.accounts` — a wrong signer fails closed.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import * as Hex from "ox/Hex";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";

import { ChainError } from "../index.ts";
import { tronAddressFromEvm } from "./address.ts";
import { tronMessageDigest } from "./message.ts";

/** The signer of a 65-byte r‖s‖v signature (v∈{27,28}), as a base58 TRON address. */
const recover = (payload: Uint8Array, signature: Uint8Array): string => {
  if (signature.length !== 65) {
    throw new ChainError("invalid-request", "a TRON signature is 65 bytes");
  }
  const v = signature.at(-1);
  if (v !== 27 && v !== 28) {
    throw new ChainError("invalid-request", "TRON signature v is not 27 or 28");
  }
  try {
    return tronAddressFromEvm(
      Secp256k1.recoverAddress({
        payload: Hex.fromBytes(payload),
        signature: Signature.fromBytes(signature),
      }),
    );
  } catch (error) {
    if (error instanceof ChainError) {
      throw error;
    }
    throw new ChainError("invalid-request", "signature does not recover a public key");
  }
};

/** Recovers the signer address of a transaction signature over sha256(raw_data). */
export const recoverTronTransactionSigner = (rawData: Uint8Array, signature: Uint8Array): string =>
  recover(sha256(rawData), signature);

/** Recovers the signer address of a TIP-191 message signature. */
export const recoverTronMessageSigner = (message: Uint8Array, signature: Uint8Array): string =>
  recover(tronMessageDigest(message), signature);

/** Whether `signature` signs sha256(rawData) for `address` — false on any error. */
export const verifyTronTransactionSignature = (
  rawData: Uint8Array,
  signature: Uint8Array,
  address: string,
): boolean => {
  try {
    return recoverTronTransactionSigner(rawData, signature) === address;
  } catch {
    return false;
  }
};

/** Whether `signature` signs the TIP-191 digest of `message` for `address` — false on any error. */
export const verifyTronMessageSignature = (
  message: Uint8Array,
  signature: Uint8Array,
  address: string,
): boolean => {
  try {
    return recoverTronMessageSigner(message, signature) === address;
  } catch {
    return false;
  }
};
