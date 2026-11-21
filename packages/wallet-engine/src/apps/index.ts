/**
 * `@qntx/wallet-engine/apps` — app providers the main engine entry never loads: a host that
 * composes apps imports this entry next to `createWalletEngine`, so hosts that do not pay nothing.
 * Platform-neutral like the rest of src: every I/O dependency (fetch, timers, clock) is injected.
 *
 * `createHyperliquidProvider` builds the Hyperliquid read and L1-trading path: market and account
 * info reads over the SDK's request functions on an injected transport (never its HttpTransport,
 * which owns the global fetch and timers), pure quote previews that apply the tick and lot rules
 * with bigint-exact arithmetic, and `trade` — actions signed by the wallet's enabled agent through
 * `hyperliquid(wallet).signL1` and posted exactly as signed.
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
export type {
  HyperliquidAgent,
  HyperliquidAgentRegistry,
  HyperliquidGroup,
} from "./hyperliquid/agents.ts";
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
