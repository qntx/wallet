/**
 * Transfer message forms (protocol.md §9.12–9.14, §11). The signed messages the host verifies:
 * `offer` binds the target's link key to its identity, `export` binds source, target, link key and
 * the ephemeral to the source's identity.
 */
import { concatBytes } from "@noble/hashes/utils.js";

import { ascii } from "./bytes.ts";

/** The OFFER response: `LK(65) ‖ Sign(idKey_T, "qntx-card/v1/offer" ‖ LK)(64)` (§9.12). */
export type Offer = {
  readonly linkKey: Uint8Array;
  readonly signature: Uint8Array;
};

/** The EXPORT head response: `E(65) ‖ Sign(idKey_S, M)(64)` with `M` from §9.13. */
export type ExportHead = {
  readonly ephemeral: Uint8Array;
  readonly signature: Uint8Array;
};

const LABEL_OFFER = ascii("qntx-card/v1/offer");
const LABEL_EXPORT = ascii("qntx-card/v1/export");

/** `"qntx-card/v1/offer" ‖ LK` — what the target's identity key signs. */
export function offerMessage(linkKey: Uint8Array): Uint8Array {
  return concatBytes(LABEL_OFFER, linkKey);
}

/** `"qntx-card/v1/export" ‖ A_S ‖ A_T ‖ LK ‖ E` — what the source's identity key signs (§9.13). */
export function exportMessage(
  source: Uint8Array,
  target: Uint8Array,
  linkKey: Uint8Array,
  ephemeral: Uint8Array,
): Uint8Array {
  return concatBytes(LABEL_EXPORT, source, target, linkKey, ephemeral);
}
