/**
 * /evm/assemble — turn verified signature material into the wire artefact: the serialized signed
 * envelope for a transaction, the 65-byte `r‖s‖v` (v = 27 + yParity) for messages. An `eip7702`
 * transaction without its authorization returns the stage-2 plan instead.
 */
import * as Hex from "ox/Hex";
import * as Signature from "ox/Signature";

import type { Assembled } from "../index.ts";
import { acceptEcdsa, signaturesOf } from "../tasks.ts";
import { evmEnvelope } from "./envelope.ts";
import type { EvmSignPlan } from "./plan.ts";

const oxSignature = (accepted: {
  readonly r: bigint;
  readonly s: bigint;
  readonly yParity: 0 | 1;
}): Signature.Signature =>
  Signature.from({
    r: Hex.fromNumber(accepted.r),
    s: Hex.fromNumber(accepted.s),
    yParity: accepted.yParity,
  });

export const assembleEvm = (
  plan: EvmSignPlan,
  signatures: ReadonlyArray<Uint8Array>,
): Assembled<Uint8Array, EvmSignPlan> => {
  signaturesOf(plan.tasks, signatures);
  const signature = oxSignature(acceptEcdsa(plan.tasks[0], signatures[0] ?? new Uint8Array()));
  if (plan.kind !== "evm.transaction") {
    return { kind: "signed", artefact: Signature.toBytes(signature) };
  }
  if (plan.tx.type === "eip7702" && plan.authorization === undefined) {
    // Stage 1: the verified authorization signature enters the envelope whose digest is stage 2.
    return {
      kind: "next",
      plan: {
        ...plan,
        authorization: Signature.toBytes(signature),
        tasks: [
          {
            ...plan.tasks[0],
            digest: Hex.toBytes(evmEnvelope(plan.tx, signature).payload),
          },
        ],
      },
    };
  }
  const envelope = evmEnvelope(
    plan.tx,
    plan.authorization === undefined ? undefined : Signature.fromBytes(plan.authorization),
  );
  return { kind: "signed", artefact: Hex.toBytes(envelope.serialize(signature)) };
};
