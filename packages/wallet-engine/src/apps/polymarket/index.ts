/**
 * `@qntx/wallet-engine/apps/polymarket` — the Polymarket app: `polymarket(config)` returns the
 * definition `createApps` lists, and this entry carries the provider's whole surface
 * (market/account reads, kernel-described order signing, live book/account views, pUSD funding
 * through the request pipeline and the host's builder-signed relayer). A host that never imports
 * it bundles none of it.
 */
export { polymarket } from "./app.ts";
export type { AppsPolymarketConfig } from "./app.ts";
export { PolymarketError } from "./errors.ts";
export type { PolymarketErrorCategory } from "./errors.ts";
export type {
  PolymarketBuilder,
  PolymarketBuilderHeaders,
  PolymarketProvider,
} from "./provider.ts";
export type {
  PolymarketBook,
  PolymarketClobMarket,
  PolymarketEvent,
  PolymarketEventsParams,
  PolymarketHistoryParams,
  PolymarketMarket,
  PolymarketMarkets,
  PolymarketPricePoint,
  PolymarketResolution,
} from "./markets.ts";
export type {
  PolymarketAccount,
  PolymarketAccountReads,
  PolymarketActivity,
  PolymarketActivityParams,
  PolymarketApproval,
  PolymarketApprovals,
  PolymarketBalance,
  PolymarketOpenOrdersParams,
  PolymarketOrder,
  PolymarketPage,
  PolymarketPnl,
  PolymarketPnlParams,
  PolymarketPnlPoint,
  PolymarketPosition,
  PolymarketPositionsParams,
  PolymarketTrade,
  PolymarketTradesParams,
} from "./account.ts";
export type { PolymarketWalletCandidates, PolymarketWallets } from "./wallets.ts";
export type {
  PolymarketExchangeDomain,
  PolymarketLimitParams,
  PolymarketMarketParams,
  PolymarketOrderDraft,
  PolymarketOrderType,
  PolymarketQuote,
  PolymarketQuoteFees,
  PolymarketSide,
} from "./orders.ts";
export type {
  PolymarketCancelResult,
  PolymarketOrderOutcome,
  PolymarketPlaceParams,
  PolymarketPlacedOrder,
  PolymarketRejectReason,
  PolymarketTrading,
} from "./trade.ts";
export type {
  PolymarketAccountLiveData,
  PolymarketBookData,
  PolymarketBookLevel,
  PolymarketLive,
  PolymarketLiveState,
  PolymarketLiveView,
  PolymarketMarketData,
} from "./live.ts";
export type { PolymarketFunding, PolymarketFundingOutcome } from "./funding.ts";
