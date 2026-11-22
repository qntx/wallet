/**
 * /bitcoin/assemble — graft the verified signature material onto the planned artefact: partial
 * signatures / tapKeySig into a fresh parse of the planned PSBT, or the witness / compact-signature
 * string of a message request. Always "signed".
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { SigHash, Transaction } from "@scure/btc-signer/transaction.js";
import { concatBytes } from "@scure/btc-signer/utils.js";

import { ChainError } from "../index.ts";
import type { Assembled } from "../index.ts";
import { acceptBip340, acceptEcdsa, signaturesOf } from "../tasks.ts";
import { encodeBip322Simple, encodeLegacySignature } from "./message.ts";
import type { BitcoinMessagePlan, BitcoinPsbtPlan } from "./plan.ts";

const der = (r: bigint, s: bigint): Uint8Array => new secp256k1.Signature(r, s).toBytes("der");

const compact = (r: bigint, s: bigint): Uint8Array =>
  new secp256k1.Signature(r, s).toBytes("compact");

/** The artefact `signIdx` produced: partialSig DER‖sighash, or tapKeySig sig[‖sighash]. */
export const assembleBitcoinPsbt = (
  plan: BitcoinPsbtPlan,
  signatures: ReadonlyArray<Uint8Array>,
): Assembled<Uint8Array, BitcoinPsbtPlan> => {
  signaturesOf(plan.tasks, signatures);
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(plan.psbt);
  } catch {
    throw new ChainError("invalid-request", "PSBT failed to decode");
  }
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    const input = plan.inputs[i];
    const signature = signatures[i];
    if (task === undefined || input === undefined || signature === undefined) {
      throw new ChainError("invalid-signature", "plan is malformed");
    }
    if (task.scheme === "bip340") {
      const sig = acceptBip340(task, signature);
      tx.updateInput(
        input.index,
        {
          tapKeySig:
            input.sighash === SigHash.DEFAULT
              ? sig
              : concatBytes(sig, Uint8Array.of(input.sighash)),
        },
        true,
      );
    } else {
      const { r, s } = acceptEcdsa(task, signature);
      tx.updateInput(
        input.index,
        { partialSig: [[input.publicKey, concatBytes(der(r, s), Uint8Array.of(input.sighash))]] },
        true,
      );
    }
  }
  return { kind: "signed", artefact: tx.toPSBT(0) };
};

/** The `smp` witness encoding for bip322-simple, the compact base64 signature for legacy. */
export const assembleBitcoinMessage = (
  plan: BitcoinMessagePlan,
  signatures: ReadonlyArray<Uint8Array>,
): Assembled<string, BitcoinMessagePlan> => {
  signaturesOf(plan.tasks, signatures);
  const task = plan.tasks[0];
  const signature = signatures[0] ?? new Uint8Array();
  if (task.scheme === "bip340") {
    return { kind: "signed", artefact: encodeBip322Simple([acceptBip340(task, signature)]) };
  }
  const { r, s, yParity } = acceptEcdsa(task, signature);
  if (plan.format === "legacy") {
    return { kind: "signed", artefact: encodeLegacySignature(yParity, compact(r, s)) };
  }
  // bip322-simple P2WPKH witness: [DER signature ‖ SIGHASH_ALL, compressed pubkey].
  const witness = [
    concatBytes(der(r, s), Uint8Array.of(SigHash.ALL)),
    plan.publicKey,
  ];
  return { kind: "signed", artefact: encodeBip322Simple(witness) };
};
