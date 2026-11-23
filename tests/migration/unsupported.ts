import type { PricesState, WalletEngine } from "@qntx/wallet-engine";

/**
 * The gateway answers `unsupported` — permanently — where it has no coverage at all, instead of a
 * retryable failure or a silent gap. Three surfaces carry it:
 *
 * - `POST /v1/history/:caip2` on a served network with no history provider answers 404 `unsupported`;
 *   the engine ends that network's stream and lists its id in `GroupHistory.unsupported` — the
 *   entry list is complete for every other network, so show a "no history for X" notice rather than
 *   a load error.
 * - `GET /v1/tokens/:caip2` on a served network no token source covers answers 404 `unsupported`; a
 *   covered network whose build has not landed yet still answers 503 `unavailable` with
 *   `Retry-After`. Either stores an empty list.
 * - `POST /v1/prices/:family` reports assets no provider maps in a new `unsupported` list, distinct
 *   from `missing` (no price right now). `PricesState.errors` values them `"unsupported"` — a
 *   permanent state, so grey the price out instead of hinting a retry — and drops any stored quote
 *   for the asset.
 */
export function describeCoverage(engine: WalletEngine): () => void {
  const stop = engine.history.store.subscribe((state) => {
    for (const history of Object.values(state.groups)) {
      // `truncated` still means "the list has gaps here"; `unsupported` means the network has
      // no history on this gateway at all.
      for (const network of history.unsupported) {
        void network; // render: this network has no history service
      }
    }
  });
  void stop;
  return engine.prices.store.subscribe((state: PricesState) => {
    for (const [asset, error] of Object.entries(state.errors)) {
      // "unpriced": no provider had a price now — may resolve on the next fetch.
      // "unsupported": no provider maps the asset — permanent.
      void [asset, error satisfies "unpriced" | "unsupported"];
    }
  });
}
