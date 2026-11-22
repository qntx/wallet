/**
 * Wei25519 → edwards25519 mapping (protocol.md §10.4). The card emits `W(P) = X ‖ Y`, affine
 * coordinates big-endian; the host maps it to the edwards point and re-encodes. Every failure is
 * `card-fault`: the input is always card output.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";

import { CardError } from "./errors.ts";

const { Fp } = ed25519.Point;

/** A₃ = 486662/3 mod q, the Montgomery-to-Wei25519 offset of §10.4. */
const A3 = BigInt("0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2451");
/** Sqrt(−486664 mod q), the root that maps G_W onto the RFC 8032 base point (§10.4). */
const C = BigInt("0x70d9120b9f5ff9442d84f723fc03b0813a5e2c2eb482e57d3391fb5500ba81e7");

const fault = (message: string): never => {
  throw new CardError("card-fault", message);
};

/**
 * `u = X − A₃`, `y = (u−1)(u+1)⁻¹`, `x = c·u·Y⁻¹` (mod q), then encode per RFC 8032 §5.1.2. Rejects
 * non-canonical coordinates, `Y = 0`, `u + 1 = 0`, and any result that is off the edwards curve,
 * the identity, or in the torsion subgroup.
 */
export function edwardsEncode(wei: Uint8Array): Uint8Array {
  if (wei.length !== 64) {
    fault("Wei25519 point is not 64 bytes");
  }
  const x0 = bytesToNumberBE(wei.subarray(0, 32));
  const y0 = bytesToNumberBE(wei.subarray(32, 64));
  if (x0 >= Fp.ORDER || y0 >= Fp.ORDER) {
    fault("Wei25519 coordinate is not reduced mod q");
  }
  if (Fp.is0(y0)) {
    fault("Wei25519 Y is zero");
  }
  const u = Fp.sub(x0, A3);
  const uPlusOne = Fp.add(u, Fp.ONE);
  if (Fp.is0(uPlusOne)) {
    fault("Wei25519 point has no edwards image");
  }
  const y = Fp.mul(Fp.sub(u, Fp.ONE), Fp.inv(uPlusOne));
  const x = Fp.mul(Fp.mul(C, u), Fp.inv(y0));
  const point = ed25519.Point.fromAffine({ x, y });
  try {
    point.assertValidity();
  } catch {
    fault("Wei25519 point does not map onto edwards25519");
  }
  // y = 1 (the identity) would need u − 1 = u + 1, so only torsion remains possible
  if (!point.isTorsionFree()) {
    fault("Wei25519 point maps to a torsion point");
  }
  return point.toBytes();
}
