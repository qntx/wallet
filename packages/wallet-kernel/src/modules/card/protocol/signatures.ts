/**
 * Signature verification and assembly for card signing commands (protocol.md §12). Card outputs are
 * verified before they are returned; any failure is `card-fault`. Arguments the host itself
 * produced (keys, digests, tweaks, member parameters) are shape-checked first and throw
 * `invalid-input`.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { concatBytes } from "@noble/hashes/utils.js";

import { validPoint } from "./bytes.ts";
import { CardError } from "./errors.ts";

const N = secp256k1.Point.Fn.ORDER;

const fault = (message: string): never => {
  throw new CardError("card-fault", message);
};

const input = (message: string): never => {
  throw new CardError("invalid-input", message);
};

function exact(data: Uint8Array, length: number, what: string): void {
  if (data.length !== length) {
    input(`${what} is not ${length} bytes`);
  }
}

/** Compressed secp256k1 key argument: 33 bytes on the curve. */
function checkIdentityKey(key: Uint8Array, what: string): void {
  exact(key, 33, what);
  if (!validPoint(key)) {
    input(`${what} is not a valid point`);
  }
}

export type EcdsaResult = {
  /** `r ‖ min(s, n−s)` — the signature normalised to low s. */
  readonly signature: Uint8Array;
  /** The recid under which the low-s signature recovers `publicKey`. */
  readonly recovery: 0 | 1;
};

function recoveryBit(r: bigint, lowS: bigint, digest: Uint8Array, publicKey: Uint8Array): 0 | 1 {
  // The signature already verified, so exactly one recovery bit reproduces `publicKey`.
  const recovered = new secp256k1.Signature(r, lowS)
    .addRecoveryBit(0)
    .recoverPublicKey(digest)
    .toBytes(true);
  return equalBytes(recovered, publicKey) ? 0 : 1;
}

/**
 * §12.1: card output `r ‖ s` over a pre-computed `digest`; `s` may be high. The host verifies
 * (accepting high s), normalises to low s and derives the recovery bit. A repeated `r` — any value
 * in `previousR` — is a card fault: the card must never reuse a nonce point.
 */
export function ecdsa(
  data: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
  previousR: ReadonlyArray<Uint8Array>,
): EcdsaResult {
  exact(digest, 32, "digest");
  checkIdentityKey(publicKey, "publicKey");
  for (const r of previousR) {
    exact(r, 32, "previousR entry");
  }
  if (data.length !== 64) {
    fault("SIGN_ECDSA response is not 64 bytes");
  }
  const rBytes = data.subarray(0, 32);
  const r = bytesToNumberBE(rBytes);
  const s = bytesToNumberBE(data.subarray(32, 64));
  // noble's verify parses the signature and rejects r, s outside [1, n−1] by returning false
  if (!secp256k1.verify(data, digest, publicKey, { prehash: false, lowS: false })) {
    fault("ECDSA signature does not verify");
  }
  if (previousR.some((previous) => equalBytes(previous, rBytes))) {
    fault("card reused an r value");
  }
  const lowS = s > N / 2n ? N - s : s;
  const signature = concatBytes(numberToBytesBE(r, 32), numberToBytesBE(lowS, 32));
  return { signature, recovery: recoveryBit(r, lowS, digest, publicKey) };
}

/**
 * `TaggedHash("TapTweak", x(P) ‖ merkleRoot)` (§12.2): the key-path spend tweak when `merkleRoot`
 * is empty, the script-tree tweak for 32 bytes.
 */
export function taprootTweak(internalKey: Uint8Array, merkleRoot: Uint8Array): Uint8Array {
  checkIdentityKey(internalKey, "internalKey");
  if (merkleRoot.length > 0 && merkleRoot.length !== 32) {
    input("merkleRoot is not empty or 32 bytes");
  }
  return schnorr.utils.taggedHash("TapTweak", internalKey.subarray(1, 33), merkleRoot);
}

/**
 * §12.2: verifies `R_x ‖ s` under the tweaked output key `Q = lift_x(x(P)) + t·G` (BIP-341,
 * `lift_x` picks the even-y lift so an odd internal key is negated first). Returns the signature on
 * success.
 */
export function bip340(
  data: Uint8Array,
  message: Uint8Array,
  internalKey: Uint8Array,
  tweak: Uint8Array,
): Uint8Array {
  exact(message, 32, "message");
  checkIdentityKey(internalKey, "internalKey");
  exact(tweak, 32, "tweak");
  const t = bytesToNumberBE(tweak);
  if (t >= N) {
    input("tweak is not below the curve order");
  }
  if (data.length !== 64) {
    fault("SIGN_BIP340 response is not 64 bytes");
  }
  const x = bytesToNumberBE(internalKey.subarray(1, 33));
  let outputX: Uint8Array;
  try {
    const internal = schnorr.utils.lift_x(x);
    // BASE.multiply(0) throws in noble; t = 0 means Q = P′ directly (§12.2)
    const output = t === 0n ? internal : internal.add(secp256k1.Point.BASE.multiply(t));
    outputX = schnorr.utils.pointToBytes(output);
  } catch {
    return fault("tweaked output key is not on the curve");
  }
  if (!schnorr.verify(data, message, outputX)) {
    fault("BIP-340 signature does not verify under the tweaked key");
  }
  return new Uint8Array(data);
}

/**
 * §12.3: card output `le32(S)` for a stream `encode(R) ‖ encode(A) ‖ M`. Requires `S < ℓ`,
 * assembles `encode(R) ‖ le32(S)` and verifies it under strict RFC 8032 rules.
 */
export function ed25519Signature(
  data: Uint8Array,
  encodedR: Uint8Array,
  publicKey: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  exact(encodedR, 32, "encodedR");
  exact(publicKey, 32, "publicKey");
  if (data.length !== 32) {
    fault("SIGN_ED25519 finish response is not 32 bytes");
  }
  // noble's strict (zip215: false) verify already rejects S ≥ ℓ
  const signature = concatBytes(encodedR, data);
  if (!ed25519.verify(signature, message, publicKey, { zip215: false })) {
    fault("assembled Ed25519 signature does not verify");
  }
  return signature;
}
