/**
 * Signing tasks — the serialisable middle of the `plan → backend → assemble` split. A plan is
 * plain data (no key material, no closures); a backend returns one 64-byte signature per task;
 * `assemble` verifies every signature against the task's public key before using it. The task
 * types live in the root entry (declaring them here would cycle index ↔ tasks); the helpers
 * stay package-internal.
 */
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { ed25519 } from "@noble/curves/ed25519.js";

import { ChainError } from "./index.ts";
import type { Assembled, Bip340Task, EcdsaTask, Ed25519Task, SignTask } from "./index.ts";

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Checks a backend's 64-byte `r‖s` signature: `s` may be high (a backend that does not normalize
 * — the card, protocol.md §12.1 — is normalized here, never refused); the recovery bit is found
 * by recovering the key for both parities and comparing with the task key — that comparison is
 * the verification.
 */
export const acceptEcdsa = (
  task: EcdsaTask,
  signature: Uint8Array,
): { readonly r: bigint; readonly s: bigint; readonly yParity: 0 | 1 } => {
  if (signature.length !== 64) {
    throw new ChainError("invalid-signature", "signature must be 64 bytes");
  }
  let parsed;
  try {
    parsed = secp256k1.Signature.fromBytes(signature, "compact");
  } catch {
    throw new ChainError("invalid-signature", "signature does not verify under the task key");
  }
  // noble 2.x Signature has no normalizeS: `n − s` is the same low-s normalization.
  const sig = parsed.hasHighS()
    ? new secp256k1.Signature(parsed.r, secp256k1.Point.Fn.neg(parsed.s))
    : parsed;
  for (const yParity of [0, 1] as const) {
    let recovered: Uint8Array | undefined;
    try {
      recovered = sig.addRecoveryBit(yParity).recoverPublicKey(task.digest).toBytes(true);
    } catch {
      recovered = undefined;
    }
    if (recovered !== undefined && equalBytes(recovered, task.publicKey)) {
      return { r: sig.r, s: sig.s, yParity };
    }
  }
  throw new ChainError("invalid-signature", "signature does not verify under the task key");
};

/** Checks a backend's 64-byte `R_x‖s` Schnorr signature against the task's output key. */
export const acceptBip340 = (task: Bip340Task, signature: Uint8Array): Uint8Array => {
  if (signature.length !== 64) {
    throw new ChainError("invalid-signature", "signature must be 64 bytes");
  }
  let ok = false;
  try {
    ok = schnorr.verify(signature, task.message, task.publicKey);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new ChainError("invalid-signature", "signature does not verify under the task key");
  }
  return signature;
};

/** Checks a backend's 64-byte `R‖S` Ed25519 signature under strict RFC 8032 rules. */
export const acceptEd25519 = (task: Ed25519Task, signature: Uint8Array): Uint8Array => {
  if (signature.length !== 64) {
    throw new ChainError("invalid-signature", "signature must be 64 bytes");
  }
  let ok = false;
  try {
    ok = ed25519.verify(signature, task.message, task.publicKey, { zip215: false });
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new ChainError("invalid-signature", "signature does not verify under the task key");
  }
  return signature;
};

/** Every assemble starts here: a backend must return exactly one signature per task. */
export const signaturesOf = (
  tasks: ReadonlyArray<SignTask>,
  signatures: ReadonlyArray<Uint8Array>,
): void => {
  if (signatures.length !== tasks.length) {
    throw new ChainError(
      "invalid-signature",
      `expected ${tasks.length} signatures, got ${signatures.length}`,
    );
  }
};

/**
 * The synchronous driver the raw-key wrappers use: sign every task of the current plan, assemble,
 * and repeat while assemble returns a dependent "next" plan (EIP-7702's two stages).
 */
export const signLocally = <P extends { readonly tasks: ReadonlyArray<SignTask> }, A>(
  plan: P,
  sign: (task: SignTask, index: number) => Uint8Array,
  assemble: (plan: P, signatures: ReadonlyArray<Uint8Array>) => Assembled<A, P>,
): A => {
  let current = plan;
  for (;;) {
    const signatures = current.tasks.map((task, index) => sign(task, index));
    const result = assemble(current, signatures);
    if (result.kind === "signed") {
      return result.artefact;
    }
    current = result.plan;
  }
};
