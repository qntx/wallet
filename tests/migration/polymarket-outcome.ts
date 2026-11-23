/**
 * Polymarket order outcomes without `not-found`: an order no reconcile read saw is `unknown`, its
 * defensive `DELETE /order` result rides `cancel`, and the eventual status arrives through
 * `trade.corrections`. `unknown` is never a reason to place the order again.
 */
import type {
  PolymarketCancelAttempt,
  PolymarketOrderOutcome,
  PolymarketProvider,
} from "@qntx/wallet-engine/apps/polymarket";

/** Before: `case "not-found": offerRetry()`. After: `not-found` is gone and `unknown` never retries. */
export function describeOutcome(outcome: PolymarketOrderOutcome): string {
  switch (outcome.kind) {
    case "resting":
    case "matched":
    case "delayed":
      return `order ${outcome.orderId} is on the book`;
    case "unmatched":
      return `order ${outcome.orderId} did not rest`;
    /* `canceled` now carries `making` — the order row's `size_matched`. A value above "0" is a
       partial fill taken before the cancel; re-place only the unfilled remainder. */
    case "canceled":
      return `order ${outcome.orderId} canceled after filling ${outcome.making}`;
    case "rejected":
      return `refused: ${outcome.message}`;
    case "unknown":
      return `order ${outcome.orderId} may exist — do not place it again (${cancelNote(outcome.cancel)})`;
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/** `undefined` means a reconcile read saw the order; otherwise the defensive cancel's result. */
export function cancelNote(cancel: PolymarketCancelAttempt | undefined): string {
  if (cancel === undefined) {
    return "seen by a reconcile read";
  }
  switch (cancel.kind) {
    case "canceled":
      return "canceled by id";
    case "not-canceled":
      return `cancel refused: ${cancel.reason}`;
    case "failed":
      return `cancel failed: ${cancel.message}`;
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = cancel;
      return exhaustive;
    }
  }
}

/** Fold late corrections into the order list — one per `unknown` that later proves a status. */
export function watchCorrections(
  pm: PolymarketProvider,
  onOutcome: (orderId: string, line: string) => void,
): () => void {
  return pm.trade.corrections.subscribe((correction) => {
    onOutcome(correction.orderId, describeOutcome(correction.outcome));
  });
}
