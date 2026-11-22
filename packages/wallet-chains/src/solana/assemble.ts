/**
 * /solana/assemble — the verified 64-byte Ed25519 signature is itself the wire artefact (the host
 * attaches it to the compiled transaction). Always "signed".
 */
import type { Assembled } from "../index.ts";
import { acceptEd25519, signaturesOf } from "../tasks.ts";
import type { SolanaSignPlan } from "./plan.ts";

export const assembleSolana = (
  plan: SolanaSignPlan,
  signatures: ReadonlyArray<Uint8Array>,
): Assembled<Uint8Array, SolanaSignPlan> => {
  signaturesOf(plan.tasks, signatures);
  return {
    kind: "signed",
    artefact: acceptEd25519(plan.tasks[0], signatures[0] ?? new Uint8Array()),
  };
};
