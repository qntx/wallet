/**
 * /tron/assemble — the verified signature material as the 65-byte `r‖s‖v` (v = 27 + yParity),
 * the tronweb ECKeySign form. Always "signed".
 */
import * as Hex from "ox/Hex";
import * as Signature from "ox/Signature";

import type { Assembled } from "../index.ts";
import { acceptEcdsa, signaturesOf } from "../tasks.ts";
import type { TronSignPlan } from "./plan.ts";

export const assembleTron = (
  plan: TronSignPlan,
  signatures: ReadonlyArray<Uint8Array>,
): Assembled<Uint8Array, TronSignPlan> => {
  signaturesOf(plan.tasks, signatures);
  const { r, s, yParity } = acceptEcdsa(plan.tasks[0], signatures[0] ?? new Uint8Array());
  return {
    kind: "signed",
    artefact: Signature.toBytes(
      Signature.from({ r: Hex.fromNumber(r), s: Hex.fromNumber(s), yParity }),
    ),
  };
};
