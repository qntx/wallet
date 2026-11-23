import type { ChainErrorCode, EcdsaTask, SignTask } from "@qntx/wallet-chains";
import { ChainError } from "@qntx/wallet-chains";
import { assembleEvm, planEvm } from "@qntx/wallet-chains/evm";
import type { EvmSignPlan } from "@qntx/wallet-chains/evm";

/**
 * Exhaustive map: `ChainErrorCode` gained `invalid-signature` — an assemble step refused signature
 * material that does not verify under the task's public key.
 */
export const CHAIN_ERROR_IS_NEW: Readonly<Record<ChainErrorCode, boolean>> = {
  "unknown-field": false,
  "chain-id-mismatch": false,
  "invalid-quantity": false,
  "invalid-address": false,
  "invalid-typed-data": false,
  "invalid-request": false,
  "invalid-signature": true,
  unsupported: false,
};

/** Every signing task names its scheme; a signer that serves only digests handles `ecdsa-secp256k1`. */
const ecdsaOnly = (task: SignTask): EcdsaTask => {
  if (task.scheme !== "ecdsa-secp256k1") {
    throw new ChainError("unsupported", `${task.scheme} is not served by this signer`);
  }
  return task;
};

/**
 * A digest signer outside the wallet (it returns a 64-byte `r ‖ s`, any `s`, no recovery id) signs
 * an EVM request: plan, sign every task, assemble — repeating while assemble returns the next stage
 * (an EIP-7702 transaction has two). Assemble verifies each signature against the task key.
 */
export const signWithDigestSigner = async (
  request: Parameters<typeof planEvm>[0],
  key: Parameters<typeof planEvm>[1],
  signDigest: (path: ReadonlyArray<number>, digest: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> => {
  let plan: EvmSignPlan = planEvm(request, key);
  for (;;) {
    const signatures: Uint8Array[] = [];
    for (const task of plan.tasks) {
      const { path, digest } = ecdsaOnly(task);
      // oxlint-disable-next-line no-await-in-loop -- a hardware signer serves one task at a time
      signatures.push(await signDigest(path, digest));
    }
    const assembled = assembleEvm(plan, signatures);
    if (assembled.kind === "signed") {
      return assembled.artefact;
    }
    ({ plan } = assembled);
  }
};
