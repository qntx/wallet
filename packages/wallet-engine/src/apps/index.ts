/**
 * `@qntx/wallet-engine/apps` — the apps composition the main engine entry never loads: a host that
 * enables app trading imports this entry next to `createWalletEngine`, so hosts that do not pay
 * nothing. Platform-neutral like the rest of src: every I/O dependency (fetch, timers, clock) is
 * injected.
 *
 * `createApps` builds the whole surface: the `AppsController` (enablement state, terms
 * acknowledgement, lifecycle on the wallet's lock state) and the `hyperliquid` provider — market
 * and account reads, pure quote previews, L1 `trade` signed by the wallet's enabled agent,
 * user-signed `transfer`/`fund` through the request pipeline. Internal seams (the agent registry,
 * provider factories, flow types) stay in the source tree; tests import them by path.
 */
export { createApps } from "./controller.ts";
export type { AppsController } from "./controller.ts";
export type {
  AppsBuilderConfig,
  AppsHyperliquidConfig,
  AppsPolymarketConfig,
  CreateAppsOptions,
} from "./controller.ts";
export type { AppGroup, AppGroupState, AppId, AppsState } from "./types.ts";
export { HyperliquidError } from "./hyperliquid/errors.ts";
export type { HyperliquidErrorCategory } from "./hyperliquid/errors.ts";
export { HYPERLIQUID_DEPOSIT } from "./hyperliquid/provider.ts";
export type {
  HyperliquidDepositInfo,
  HyperliquidFund,
  HyperliquidProvider,
  HyperliquidQuote,
  HyperliquidQuotePreview,
} from "./hyperliquid/provider.ts";
export type { HyperliquidPendingAction } from "./hyperliquid/user-signed.ts";
export type {
  AppSocket,
  HyperliquidSocket,
  HyperliquidSocketStatus,
} from "./hyperliquid/socket.ts";
export type { HyperliquidLive, LiveState, LiveView } from "./hyperliquid/live.ts";
export type { HyperliquidAgent, HyperliquidGroup } from "./hyperliquid/agents.ts";
export type { HyperliquidClock } from "./hyperliquid/clock.ts";
export type {
  HyperliquidAsset,
  HyperliquidModifyParams,
  HyperliquidOrderKind,
  HyperliquidOrderParams,
  HyperliquidTriggerParams,
} from "./hyperliquid/actions.ts";
export type {
  HyperliquidActionOutcome,
  HyperliquidCancelOutcome,
  HyperliquidOrderOutcome,
  HyperliquidRejectReason,
} from "./hyperliquid/exchange.ts";
export type { HyperliquidPlaceResult, HyperliquidTrade } from "./hyperliquid/trade.ts";
export type { HyperliquidMarket, OrderSide, RoundDirection } from "./hyperliquid/numbers.ts";
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
} from "./hyperliquid/markets.ts";
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
} from "./hyperliquid/account.ts";
export { PolymarketError } from "./polymarket/errors.ts";
export type { PolymarketErrorCategory } from "./polymarket/errors.ts";
export type {
  PolymarketBuilder,
  PolymarketBuilderHeaders,
  PolymarketProvider,
} from "./polymarket/provider.ts";
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
} from "./polymarket/markets.ts";
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
} from "./polymarket/account.ts";
export type { PolymarketWalletCandidates, PolymarketWallets } from "./polymarket/wallets.ts";
export type {
  PolymarketExchangeDomain,
  PolymarketLimitParams,
  PolymarketMarketParams,
  PolymarketOrderDraft,
  PolymarketOrderType,
  PolymarketQuote,
  PolymarketQuoteFees,
  PolymarketSide,
} from "./polymarket/orders.ts";
export type {
  PolymarketCancelResult,
  PolymarketOrderOutcome,
  PolymarketPlaceParams,
  PolymarketPlacedOrder,
  PolymarketRejectReason,
  PolymarketTrading,
} from "./polymarket/trade.ts";
