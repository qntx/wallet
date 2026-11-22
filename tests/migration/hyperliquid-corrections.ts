/**
 * Order outcomes that returned `unknown` are never proven "not placed" — keep them visible and
 * subscribe to `trade.corrections`: for ten minutes after the call returns the engine re-asks each
 * pending cloid via `orderStatus` (and live `openOrders`/`userFills` frames prove or re-ask them
 * too), then emits `{ group, cloid, outcome }` once a definite answer lands. Nothing is ever
 * re-sent. Compiled only; the engine README's Trading section describes the same surface.
 */
import type {
  HyperliquidOutcomeCorrection,
  HyperliquidTrade,
} from "@qntx/wallet-engine/apps/hyperliquid";

export function watchOrderCorrections(
  trade: HyperliquidTrade,
  onCorrection: (correction: HyperliquidOutcomeCorrection) => void,
): () => void {
  return trade.corrections.subscribe((correction) => {
    if (correction.outcome.kind === "unknown") {
      return; // still pending — only definite outcomes are corrections
    }
    onCorrection(correction);
  });
}
