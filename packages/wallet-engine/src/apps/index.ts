/**
 * `@qntx/wallet-engine/apps` — app providers the main engine entry never loads: a host that
 * composes apps imports this entry next to `createWalletEngine`, so hosts that do not pay nothing.
 * Platform-neutral like the rest of src: every I/O dependency (fetch, timers, clock) is injected.
 *
 * `createHyperliquidProvider` builds the Hyperliquid read path: market and account info reads over
 * the SDK's request functions on an injected transport (never its HttpTransport, which owns the
 * global fetch and timers), plus pure quote previews that apply the tick and lot rules with
 * bigint-exact arithmetic.
 */
export { createHyperliquidProvider } from "./hyperliquid/provider.ts";
export type {
  HyperliquidProvider,
  HyperliquidProviderOptions,
  HyperliquidQuote,
  HyperliquidQuotePreview,
} from "./hyperliquid/provider.ts";
export { HyperliquidError } from "./hyperliquid/errors.ts";
export type { HyperliquidErrorCategory } from "./hyperliquid/errors.ts";
export type { HyperliquidClock } from "./hyperliquid/clock.ts";
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
