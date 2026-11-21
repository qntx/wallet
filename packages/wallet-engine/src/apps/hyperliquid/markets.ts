import {
  allMids,
  candleSnapshot,
  fundingHistory,
  l2Book,
  metaAndAssetCtxs,
  predictedFundings,
  recentTrades,
  spotMetaAndAssetCtxs,
} from "@nktkas/hyperliquid/api/info";
import type {
  AllMidsParameters,
  AllMidsResponse,
  CandleSnapshotParameters,
  CandleSnapshotResponse,
  FundingHistoryParameters,
  FundingHistoryResponse,
  InfoConfig,
  L2BookParameters,
  L2BookResponse,
  MetaAndAssetCtxsParameters,
  MetaAndAssetCtxsResponse,
  PredictedFundingsResponse,
  RecentTradesParameters,
  RecentTradesResponse,
  SpotMetaAndAssetCtxsResponse,
} from "@nktkas/hyperliquid/api/info";

/**
 * Market data reads over the injected transport — thin pass-throughs to the SDK request functions
 * so response validation, parameter schemas and return types stay the SDK's.
 */
export type HyperliquidMarkets = {
  /** Perpetual universe and per-asset contexts (mark price, funding, open interest). */
  readonly perps: (params?: MetaAndAssetCtxsParameters) => Promise<MetaAndAssetCtxsResponse>;
  /** Spot universe and per-token contexts. */
  readonly spot: () => Promise<SpotMetaAndAssetCtxsResponse>;
  /** The level-2 book snapshot for one coin. */
  readonly book: (params: L2BookParameters) => Promise<L2BookResponse>;
  /** Candles for one coin and interval over `[startTime, endTime)`. */
  readonly candles: (params: CandleSnapshotParameters) => Promise<CandleSnapshotResponse>;
  /** The most recent trades for one coin. */
  readonly trades: (params: RecentTradesParameters) => Promise<RecentTradesResponse>;
  /** Historical funding rates for one coin over `[startTime, endTime)`. */
  readonly fundingHistory: (params: FundingHistoryParameters) => Promise<FundingHistoryResponse>;
  /** Predicted funding for the next interval across all coins. */
  readonly predictedFundings: () => Promise<PredictedFundingsResponse>;
  /** All mid prices, optionally for one DEX. */
  readonly mids: (params?: AllMidsParameters) => Promise<AllMidsResponse>;
};

export type {
  AllMidsResponse,
  CandleSnapshotResponse,
  FundingHistoryResponse,
  L2BookResponse,
  MetaAndAssetCtxsResponse,
  PredictedFundingsResponse,
  RecentTradesResponse,
  SpotMetaAndAssetCtxsResponse,
} from "@nktkas/hyperliquid/api/info";

export function createHyperliquidMarkets(config: InfoConfig): HyperliquidMarkets {
  return {
    perps: async (params) => metaAndAssetCtxs(config, params ?? {}),
    spot: async () => spotMetaAndAssetCtxs(config),
    book: async (params) => l2Book(config, params),
    candles: async (params) => candleSnapshot(config, params),
    trades: async (params) => recentTrades(config, params),
    fundingHistory: async (params) => fundingHistory(config, params),
    predictedFundings: async () => predictedFundings(config),
    mids: async (params) => allMids(config, params ?? {}),
  };
}
