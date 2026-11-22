/**
 * Polymarket order outcomes: `not-found` is gone. A `place` whose POST may have committed —
 * timeout, network error, 5xx, a malformed or id-mismatched 2xx — no longer resolves "the order did
 * not land": it resolves `unknown`. Before resolving, the engine attempts one defensive `DELETE
 * /order` by the locally computed order id and records it on `outcome.cancel`; the order then keeps
 * reconciling for ten minutes and a definitive status arrives later through `trade.corrections`.
 *
 * Hosts must stop offering "try again" on `unknown`: a first order that lands late plus the retry
 * is a duplicate position — Polymarket orders sign no expiry. Surface the cancel result and the
 * eventual correction instead.
 */
import type {
  PolymarketOutcomeCorrection,
  PolymarketProvider,
} from "@qntx/wallet-engine/apps/polymarket";

/** Render a placed order's outcome — `unknown` is a pending state, not a refusal. */
export function describeOutcome(outcome: {
  readonly kind: string;
  readonly orderId?: string;
}): string {
  switch (outcome.kind) {
    case "resting":
    case "matched":
    case "delayed":
      return `order ${outcome.orderId ?? ""} is on the book`;
    case "unmatched":
    case "canceled":
      return `order ${outcome.orderId ?? ""} did not rest`;
    case "rejected":
      return "the order was refused — it never ran";
    case "unknown":
      return "the order may or may not exist — do not place it again";
    default:
      /* `not-found` no longer exists — anything else is a newer outcome the host must handle
         conservatively like `unknown`. */
      return "the order's fate is not proven — do not place it again";
  }
}

/** Subscribe once per provider to fold late corrections into the host's order display. */
export function watchCorrections(
  pm: PolymarketProvider,
  onOutcome: (orderId: string, status: string) => void,
): () => void {
  return pm.trade.corrections.subscribe((correction: PolymarketOutcomeCorrection) => {
    onOutcome(correction.orderId, correction.outcome.kind);
  });
}

/** The defensive cancel's result — show it; `not-canceled`/`failed` mean the order can still land. */
export function cancelNote(
  cancel:
    | { readonly kind: "canceled" }
    | { readonly kind: "not-canceled"; readonly reason: string }
    | { readonly kind: "failed"; readonly message: string }
    | undefined,
): string {
  if (cancel === undefined) {
    return "the order was seen by a reconcile read — it exists";
  }
  if (cancel.kind === "canceled") {
    return "the engine canceled the order id defensively";
  }
  if (cancel.kind === "not-canceled") {
    return `the CLOB refused the cancel (${cancel.reason}) — the order may be live`;
  }
  return "the cancel attempt itself failed — the order may still land";
}
