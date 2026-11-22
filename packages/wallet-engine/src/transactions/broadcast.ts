/**
 * Broadcast with an outcome that is never guessed. The signed bytes and their locally computed id
 * are persisted, and what the transaction consumes (nonce, inputs) is held, before anything leaves;
 * a failed send then fails the transaction only when the node itself refuses those bytes — and that
 * refusal is persisted durably, so bytes the user was told failed are never broadcast again. Any
 * other failure — transport error, 5xx, timeout, an endpoint naming another id — may have reached
 * the mempool, so the transaction stays `submitted` and the tracker resolves it by id.
 */
import { errorMessage, submitTx } from "./route.ts";
import type { RouteContext, TrackedTransaction } from "./route.ts";

/**
 * How long the network may not know a transaction before its row turns `stuck` — never terminal:
 * the bytes may still land, so the nonce or inputs stay held and the poll drops to the finality
 * interval until a chain answer resolves it.
 */
export const STUCK_AFTER_MS = 1_800_000;
/** The note a stuck row carries; its remedies are speed-up and cancel. */
export const STUCK_NOTE =
  "the network has not seen this transaction for 30 minutes — speed up or cancel it";
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

/**
 * The node refused the signed bytes it was shown: nothing went out, so the request may fail. Every
 * other error `submitSigned` can raise happens before the broadcast.
 */
export class BroadcastRefusedError extends Error {
  constructor(nodeError: unknown) {
    super(errorMessage(nodeError), { cause: nodeError });
    this.name = "BroadcastRefusedError";
  }
}

export type SubmittedBatch = {
  /**
   * Ids of exactly the transactions that went out (accepted or outcome unknown), in input order.
   * The stopped one and everything after it were not sent.
   */
  readonly ids: ReadonlyArray<string>;
  /** Where the batch stopped: `refused` only when the node itself rejected the bytes. */
  readonly stopped?: {
    readonly index: number;
    readonly reason: "refused" | "not-sent";
    readonly error: string;
  };
};

/**
 * Submits `count` signed transactions in order; stops at the first that does not go out — a later
 * one may depend on it, so it is never sent, and each is persisted by its own `submitSigned` just
 * before its own send so an unsent later item is never rebroadcast after a restart. Throws that
 * error when the first one does not go out (nothing was sent).
 */
export const submitInOrder = async (
  count: number,
  submit: (index: number) => Promise<string>,
): Promise<SubmittedBatch> => {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- submissions are sequential per input.
      ids.push(await submit(index));
    } catch (error) {
      if (index === 0) {
        throw error;
      }
      return {
        ids,
        stopped: {
          index,
          reason: error instanceof BroadcastRefusedError ? "refused" : "not-sent",
          error: errorMessage(error),
        },
      };
    }
  }
  return { ids };
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
 * Persists the signed bytes and id on `tx` — throwing, with nothing sent, when the vault locked
 * first — holds what it consumes, then broadcasts. Accepted or unknown → `submitted` and tracked;
 * refused → released, `failed` is written durably so the refused bytes can never be recovered as
 * `signed` later — a `signed` row the failed write lost would resurrect them — and a
 * `BroadcastRefusedError` is thrown. A locked vault or failed write cannot block the refusal: the
 * terminal row then lands through the bookkeeping retry like any other. The refusal is the only
 * error allowed out once the send was attempted: anything else happens before bytes leave.
 */
export const submitSigned = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  signed: SignedBroadcast,
): Promise<TrackedTransaction> => {
  let persisted: TrackedTransaction;
  try {
    persisted = await ctx.transition(
      tx,
      {
        ...signed.record,
        hash: signed.id,
        raw: signed.raw,
      },
      true,
    );
  } catch (error) {
    // Nothing was persisted or sent — a vault that locked first refuses the write — but the
    // caller may already hold what the transaction consumes (an EVM nonce): free it so later
    // sends are not stuck behind a gap.
    signed.release();
    throw error;
  }
  signed.hold();
  const outcome = await broadcastOutcome(signed);
  if (outcome.kind === "refused") {
    signed.release();
    const failed: Partial<TrackedTransaction> = {
      state: "failed",
      hash: undefined,
      raw: undefined,
      error: errorMessage(outcome.error),
    };
    try {
      await ctx.transition(persisted, failed, true);
    } catch {
      /* The vault locked or the store failed: the refusal still stands, so park the terminal
         row for the bookkeeping retry — a `signed` row left on disk would resurrect the
         refused bytes as `submitted` at the next unlock. */
      await ctx.transition(persisted, failed);
    }
    throw new BroadcastRefusedError(outcome.error);
  }
  if (outcome.kind === "unknown") {
    ctx.options.logger.warn(
      `transaction ${tx.id}: broadcast outcome unknown, tracking ${signed.id}`,
      outcome.error,
    );
  }
  return submitTx(ctx, persisted, signed.id);
};
