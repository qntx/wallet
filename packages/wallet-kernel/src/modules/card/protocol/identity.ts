/**
 * Card identity, card IDs and the §5.2 certificate check: `cert = A(33) ‖ r ‖ s` where `(r, s) =
 * Sign(caPrivate, "qntx-card/v1/cert" ‖ A)`. A host trusts a batch CA ("anchor") and accepts a
 * certificate when `Verify(anchor, …)` succeeds for one of them (any `s` half — the spec mandates
 * accepting both, §1).
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";

import { ascii, validUncompressedPoint } from "./bytes.ts";
import { CardError } from "./errors.ts";

const LABEL_CERT = ascii("qntx-card/v1/cert");

/** A production-batch CA key the host trusts: 65-byte uncompressed secp256k1 point. */
export type Anchor = { readonly batch: string; readonly key: Uint8Array };

/** No production batch exists yet; test anchors live in tests only. */
export const PRODUCTION_ANCHORS: ReadonlyArray<Anchor> = [];

/** `ID(A) = SHA-256(A)[0..16)`: the card ID (protocol.md §1). */
export function cardId(identity: Uint8Array): Uint8Array {
  if (identity.length !== 33) {
    throw new CardError("invalid-input", "identity is not a compressed point");
  }
  return sha256(identity).subarray(0, 16);
}

/** `short(A)`: `ID(A)[0..4)` as 8 uppercase hex digits in two groups (`XXXX-XXXX`). */
export function shortId(identity: Uint8Array): string {
  const hex = bytesToHex(cardId(identity).subarray(0, 4)).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/**
 * Verifies `cert` against `anchors` (§5.2). Returns the identity key `A` (33 bytes) and the batch
 * of the anchor that verified. `card-not-genuine` when the certificate chains to no anchor;
 * `invalid-input` when an anchor key is not a valid uncompressed point.
 */
export function verifyCertificate(
  cert: Uint8Array,
  anchors: ReadonlyArray<Anchor>,
): { identity: Uint8Array; batch: string } {
  if (cert.length !== 97) {
    throw new CardError("card-not-genuine", "certificate is not 97 bytes");
  }
  for (const anchor of anchors) {
    if (!validUncompressedPoint(anchor.key)) {
      throw new CardError("invalid-input", "anchor key is not a valid uncompressed point");
    }
  }
  const identity = cert.subarray(0, 33);
  const signature = cert.subarray(33, 97);
  const digest = sha256(concatBytes(LABEL_CERT, identity));
  for (const anchor of anchors) {
    if (secp256k1.verify(signature, digest, anchor.key, { prehash: false, lowS: false })) {
      return { identity: new Uint8Array(identity), batch: anchor.batch };
    }
  }
  throw new CardError("card-not-genuine", "certificate chains to no trusted anchor");
}
