/**
 * /solana/plan — the serialisable signing plan of a normalized request: the compiled transaction
 * message or the raw offchain bytes are signed as-is by Ed25519. No key material.
 */
import { ChainError } from "../index.ts";
import type { Ed25519Task, SignRequest, TaskKey } from "../index.ts";

export type SolanaSignPlan = {
  readonly kind: "solana.transaction" | "solana.message";
  readonly tasks: readonly [Ed25519Task];
};

export const planSolanaMessage = (
  kind: SolanaSignPlan["kind"],
  message: Uint8Array,
  key: TaskKey,
): SolanaSignPlan => {
  if (message.length === 0) {
    throw new ChainError("invalid-request", "message must not be empty");
  }
  return {
    kind,
    tasks: [{ scheme: "ed25519", path: key.path, publicKey: key.publicKey, message }],
  };
};

/** The plan of a normalized request; the task keeps the request kind so the kernel can wrap it. */
export const planSolana = (
  request: Extract<SignRequest, { kind: "solana.transaction" | "solana.message" }>,
  key: TaskKey,
): SolanaSignPlan => planSolanaMessage(request.kind, request.message, key);
