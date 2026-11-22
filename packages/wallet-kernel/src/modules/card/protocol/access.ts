/**
 * The §7.1 access-code derivation: `accessHash = Argon2id(P = code, S = "qntx-card/v1/access" ‖
 * ID(A), m = 65536, t = 3, p = 4, T = 32, v = 0x13)`. The code arrives as the ASCII bytes
 * `SecureInput` hands over, so it never becomes a JS string: 6–64 bytes, each in 0x20–0x7E —
 * anything else is `invalid-input` and never reaches Argon2id, which is injected by the host
 * runtime.
 */
import { concatBytes } from "@noble/hashes/utils.js";

import { ascii, wipe } from "./bytes.ts";
import { CardError } from "./errors.ts";

/** Argon2 cost: memory in KiB, passes over it, and lanes (RFC 9106 `m`, `t`, `p`). */
export type Argon2Cost = {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly lanes: number;
};

/** Argon2id version 0x13 with no secret and no associated data; structurally the platform type. */
export type Argon2id = (
  password: Uint8Array,
  salt: Uint8Array,
  cost: Argon2Cost,
  length: number,
) => Promise<Uint8Array>;

const LABEL_ACCESS = ascii("qntx-card/v1/access");
const COST: Argon2Cost = { memoryKiB: 65_536, passes: 3, lanes: 4 };

export async function accessHash(
  code: Uint8Array,
  cardId: Uint8Array,
  argon2id: Argon2id,
): Promise<Uint8Array> {
  if (cardId.length !== 16) {
    throw new CardError("invalid-input", "cardId is not 16 bytes");
  }
  if (code.length < 6 || code.length > 64) {
    throw new CardError("invalid-input", "access code length outside 6..64");
  }
  for (const byte of code) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new CardError("invalid-input", "access code is not printable ASCII");
    }
  }
  // the caller owns and wipes `code`; Argon2id gets this internal copy, wiped in `finally`
  const password = new Uint8Array(code);
  try {
    const derived = await argon2id(password, concatBytes(LABEL_ACCESS, cardId), COST, 32);
    if (derived.length !== 32) {
      wipe(derived);
      throw new CardError("invalid-input", "argon2id returned a hash that is not 32 bytes");
    }
    return derived;
  } finally {
    wipe(password);
  }
}
