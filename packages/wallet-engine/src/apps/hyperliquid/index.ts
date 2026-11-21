/**
 * `@qntx/wallet-engine/apps/hyperliquid` — the Hyperliquid app: `hyperliquid(config)` returns the
 * definition `createApps` lists, and this entry carries the provider's whole surface (market and
 * account reads, pure quote previews, L1 `trade` signed by the wallet's enabled agent,
 * user-signed `transfer`/`fund` through the request pipeline, WebSocket live views). A host that
 * never imports it bundles none of it — not even the `@nktkas/hyperliquid` SDK.
 */
export { hyperliquid } from "./app.ts";
export type { AppsBuilderConfig, AppsHyperliquidConfig } from "./app.ts";
export { HyperliquidError } from "./errors.ts";
export type { HyperliquidErrorCategory } from "./errors.ts";
export { HYPERLIQUID_DEPOSIT } from "./provider.ts";
export type {
  HyperliquidDepositInfo,
  HyperliquidFund,
  HyperliquidProvider,
  HyperliquidQuote,
  HyperliquidQuotePreview,
} from "./provider.ts";
export type { HyperliquidPendingAction } from "./user-signed.ts";
export type { HyperliquidSocket, HyperliquidSocketStatus } from "./socket.ts";
export type { HyperliquidLive, LiveState, LiveView } from "./live.ts";
export type { HyperliquidAgent, HyperliquidGroup } from "./agents.ts";
export type { HyperliquidClock } from "./clock.ts";
export type {
  HyperliquidAsset,
  HyperliquidModifyParams,
  HyperliquidOrderKind,
  HyperliquidOrderParams,
  HyperliquidTriggerParams,
} from "./actions.ts";
export type {
  HyperliquidActionOutcome,
  HyperliquidCancelOutcome,
  HyperliquidOrderOutcome,
  HyperliquidRejectReason,
} from "./exchange.ts";
export type { HyperliquidPlaceResult, HyperliquidTrade } from "./trade.ts";
export type { HyperliquidMarket, OrderSide, RoundDirection } from "./numbers.ts";
export type {
  AllMidsResponse,
  CandleSnapshotResponse,
  FundingHistoryResponse,
  HyperliquidMarkets,
  L2BookResponse,
  MetaAndAssetCtxsResponse,
  PredictedFundingsResponse,
  RecentTradesResponse,
  SpotMetaAndAssetCtxsResponse,
} from "./markets.ts";
export type {
  ClearinghouseStateResponse,
  ExtraAgentsResponse,
  FrontendOpenOrdersResponse,
  HyperliquidAccount,
  MaxBuilderFeeResponse,
  OrderStatusResponse,
  PortfolioResponse,
  SpotClearinghouseStateResponse,
  UserFeesResponse,
  UserFillsResponse,
  UserFundingResponse,
  UserRateLimitResponse,
  UserRoleResponse,
} from "./account.ts";
