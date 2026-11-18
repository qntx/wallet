/**
 * Broadcast with an outcome that is never guessed. The signed bytes and their locally computed id
 * are persisted, and what the transaction consumes (nonce, inputs) is held, before anything leaves;
 * a failed send then fails the transaction only when the node itself refuses those bytes. Any other
 * failure — transport error, 5xx, timeout, an endpoint naming another id — may have reached the
 * mempool, so the transaction stays `submitted` and the tracker resolves it by id.
 */
import { errorMessage, submitTx } from "./route.ts";
import type { RouteContext, TrackedTransaction } from "./route.ts";

/** How long a transaction may stay unknown to the network before it is given up as dropped. */
export const UNKNOWN_DROP_MS = 1_800_000;
/** Rebroadcast backoff for a transaction the node does not know: base doubling up to the cap. */
export const RESUBMIT_BASE_MS = 15_000;
export const RESUBMIT_MAX_MS = 600_000;

/** What a node's error says about these exact bytes, when it says anything definite. */
export type BroadcastVerdict = "held" | "refused" | undefined;

export type BroadcastOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly error: unknown }
  | { readonly kind: "unknown"; readonly error: unknown };

export type BroadcastAttempt = {
  /** The id computed from the signed bytes: EVM hash, Bitcoin txid, Solana signature. */
  readonly id: string;
  /** Sends the bytes; resolves with the id the endpoint reports. */
  readonly send: () => Promise<string>;
  /** `held`: the node already has these bytes; `refused`: it rejected them for good. */
  readonly verdict: (error: unknown) => BroadcastVerdict;
  /** Whether the network knows `id`, in the pool or on chain. */
  readonly known: () => Promise<boolean>;
};

export const broadcastOutcome = async (attempt: BroadcastAttempt): Promise<BroadcastOutcome> => {
  let reported: string;
  try {
    reported = await attempt.send();
  } catch (error) {
    const verdict = attempt.verdict(error);
    if (verdict === "held") {
      return { kind: "accepted" };
    }
    if (verdict === undefined) {
      return { kind: "unknown", error };
    }
    // A retried or failed-over send is refused (nonce too low, inputs spent) when an earlier copy
    // of the same bytes already landed.
    return (await attempt.known().catch(() => false))
      ? { kind: "accepted" }
      : { kind: "refused", error };
  }
  return reported === attempt.id
    ? { kind: "accepted" }
    : {
        kind: "unknown",
        error: new Error(`the endpoint reported ${reported} for ${attempt.id}`),
      };
};

export type SignedBroadcast = BroadcastAttempt & {
  /** The signed bytes as persisted for rebroadcast: EVM/Bitcoin hex, Solana base64 wire. */
  readonly raw: string;
  /** Build-record fields persisted with the bytes. */
  readonly record?: Partial<TrackedTransaction>;
  /** Holds what the transaction consumes once its bytes are persisted. */
  readonly hold: () => void;
  /** Frees it again when the node refuses the bytes. */
  readonly release: () => void;
};

/**
 * Persists the signed bytes and id on `tx`, holds what it consumes, then broadcasts. Accepted or
 * unknown → `submitted` and tracked; refused → `failed`, released, and the node's error thrown.
 */
export const submitSigned = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  signed: SignedBroadcast,
): Promise<TrackedTransaction> => {
  const persisted = await ctx.transition(tx, {
    ...signed.record,
    hash: signed.id,
    raw: signed.raw,
  });
  signed.hold();
  const outcome = await broadcastOutcome(signed);
  if (outcome.kind === "refused") {
    signed.release();
    await ctx.transition(persisted, {
      state: "failed",
      hash: undefined,
      raw: undefined,
      error: errorMessage(outcome.error),
    });
    throw outcome.error;
  }
  if (outcome.kind === "unknown") {
    ctx.options.logger.warn(
      `transaction ${tx.id}: broadcast outcome unknown, tracking ${signed.id}`,
      outcome.error,
    );
  }
  return submitTx(ctx, persisted, signed.id);
};
