/**
 * Plan execution — the last two stages of `validate → plan → backend → assemble`: each task goes to
 * the backend in order, then the family assembler verifies the material and produces the wire
 * artefact, wrapped as the request kind's `ChainSignResult`. A `next` plan (EIP-7702's second
 * stage) loops. A ChainError from assemble means the backend's material refused verification.
 */
import type { Assembled } from "@qntx/wallet-chains";
import { ChainError } from "@qntx/wallet-chains";
import { assembleBitcoinMessage, assembleBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinMessagePlan, BitcoinPsbtPlan } from "@qntx/wallet-chains/bitcoin";
import { signBitcoinTask } from "@qntx/wallet-chains/bitcoin/sign";
import { assembleEvm } from "@qntx/wallet-chains/evm";
import type { EvmSignPlan } from "@qntx/wallet-chains/evm";
import { signEvmTask } from "@qntx/wallet-chains/evm/sign";
import { assembleSolana } from "@qntx/wallet-chains/solana";
import type { SolanaSignPlan } from "@qntx/wallet-chains/solana";
import { signSolanaTask } from "@qntx/wallet-chains/solana/sign";
import { assembleTron } from "@qntx/wallet-chains/tron";
import type { TronSignPlan } from "@qntx/wallet-chains/tron";
import { signTronTask } from "@qntx/wallet-chains/tron/sign";
import type { ChainSignResult } from "@qntx/wallet/protocol";

import { KernelError } from "../../errors.ts";
import type { SigningBackend, TaskSigner } from "./keys.ts";

export type ChainPlan =
  | EvmSignPlan
  | TronSignPlan
  | SolanaSignPlan
  | BitcoinPsbtPlan
  | BitcoinMessagePlan;

/** The family's local task signer for the plan's scheme. */
export const taskSignerFor = (plan: ChainPlan): TaskSigner => {
  if (plan.kind.startsWith("bitcoin.")) {
    return signBitcoinTask;
  }
  if (plan.kind.startsWith("solana.")) {
    return signSolanaTask;
  }
  if (plan.kind.startsWith("tron.")) {
    return signTronTask;
  }
  return signEvmTask;
};

const wrap = <A, P extends ChainPlan>(
  result: Assembled<A, P>,
  artefact: (a: A) => ChainSignResult,
): Assembled<ChainSignResult, ChainPlan> =>
  result.kind === "signed" ? { kind: "signed", artefact: artefact(result.artefact) } : result;

/** Dispatches on the plan kind; a dependent "next" plan passes through unwrapped. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const assembleChain = (
  plan: ChainPlan,
  signatures: ReadonlyArray<Uint8Array>,
): Assembled<ChainSignResult, ChainPlan> => {
  switch (plan.kind) {
    case "evm.transaction":
      return wrap(assembleEvm(plan, signatures), (signedTransaction) => ({
        kind: plan.kind,
        signedTransaction,
      }));
    case "evm.personal-message":
    case "evm.fiat24-session":
    case "evm.typed-data":
      return wrap(assembleEvm(plan, signatures), (signature) => ({
        kind: plan.kind,
        signature,
      }));
    case "tron.transaction":
    case "tron.message":
    case "tron.typed-data":
      return wrap(assembleTron(plan, signatures), (signature) => ({
        kind: plan.kind,
        signature,
      }));
    case "solana.transaction":
    case "solana.message":
      return wrap(assembleSolana(plan, signatures), (signature) => ({
        kind: plan.kind,
        signature,
      }));
    case "bitcoin.psbt":
      return wrap(assembleBitcoinPsbt(plan, signatures), (signedPsbt) => ({
        kind: plan.kind,
        signedPsbt,
      }));
    case "bitcoin.message":
      return wrap(assembleBitcoinMessage(plan, signatures), (signature) => ({
        kind: plan.kind,
        signature,
      }));
  }
};

/**
 * Signs a plan end to end: tasks go to the backend sequentially — a hardware backend serves one at
 * a time — and every stage's material is verified during assemble before the next runs.
 */
export const signPlan = async (
  plan: ChainPlan,
  backend: SigningBackend,
): Promise<ChainSignResult> => {
  let current: ChainPlan = plan;
  for (;;) {
    const signatures: Uint8Array[] = [];
    for (const task of current.tasks) {
      // oxlint-disable-next-line no-await-in-loop -- a hardware backend serves one task at a time
      signatures.push(await backend.sign(task));
    }
    let result: Assembled<ChainSignResult, ChainPlan>;
    try {
      result = assembleChain(current, signatures);
    } catch (error) {
      if (error instanceof ChainError) {
        throw new KernelError("integrity", "backend signature refused");
      }
      throw error;
    }
    if (result.kind === "signed") {
      return result.artefact;
    }
    current = result.plan;
  }
};
