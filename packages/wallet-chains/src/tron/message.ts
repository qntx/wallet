/**
 * TRON message-signing content: the TIP-191 prefix `"\x19TRON Signed Message:\n" ‖ decimal byte
 * length ‖ message`, hashed with keccak256 (tronweb src/utils/message.ts) — the 0x19 byte
 * guarantees the preimage is never a valid `Transaction.raw`. This module owns the digest rule and
 * the transaction-shape check a `tron.message` request must pass.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

import { readFields } from "./proto.ts";
import { decodeTronRawData } from "./raw.ts";

export const TRON_MESSAGE_PREFIX = "\u0019TRON Signed Message:\n";

export const tronMessageDigest = (message: Uint8Array): Uint8Array => {
  const head = new TextEncoder().encode(`${TRON_MESSAGE_PREFIX}${message.length}`);
  const preimage = new Uint8Array(head.length + message.length);
  preimage.set(head);
  preimage.set(message, head.length);
  return keccak_256(preimage);
};

/**
 * Whether `bytes` could be a transaction: either `Transaction.raw` itself, or a `Transaction`
 * envelope whose field 1 is raw data. A `tron.message` request matching either is refused — the
 * signature would authorise a transaction, not a message.
 */
export const mayBeTronTransaction = (bytes: Uint8Array): boolean => {
  try {
    decodeTronRawData(bytes);
    return true;
  } catch {
    // Not bare raw data — try the Transaction envelope.
  }
  try {
    const rawField = readFields(bytes).find((f) => f.field === 1);
    if (rawField === undefined || rawField.wire !== 2 || rawField.data === undefined) {
      return false;
    }
    decodeTronRawData(rawField.data);
    return true;
  } catch {
    return false;
  }
};
