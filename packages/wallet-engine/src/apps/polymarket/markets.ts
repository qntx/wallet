import type * as z from "zod/mini";

/**
 * Unauthenticated Polymarket market reads: Gamma (events/markets/search), CLOB (book/price/
 * midpoint/history/market details/fee rate/server time) and Data v2 (resolutions) — every answer
 * schema-parsed then normalised. Money/size/price fields are decimal strings; asset ids are uint256
 * decimal strings; JSON-text fields are parsed strictly.
 */
import { CLOB_HOST, DATA_HOST, GAMMA_HOST } from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketHttp, PolymarketServerTime } from "./http.ts";
import {
  clobBook,
  clobFeeRate,
  clobMarketDetails,
  clobMidpoint,
  clobPrice,
  clobPricesHistory,
  dataResolutions,
  gammaEvent,
  gammaEventList,
  gammaMarket,
  gammaMarketList,
  gammaSearch,
} from "./schemas.ts";

export type PolymarketMarket = {
  readonly id: string;
  readonly conditionId: string;
  readonly questionId?: string;
  readonly question: string;
  readonly slug: string;
  readonly outcomes: ReadonlyArray<string>;
  /** PositionIds on Gamma `version: "v2"` markets, parsed `clobTokenIds` otherwise. */
  readonly assetIds: ReadonlyArray<string>;
  readonly version: "v1" | "v2";
  readonly negRisk: boolean;
  readonly tickSize: string;
  readonly minOrderSize: string;
  readonly acceptingOrders: boolean;
  readonly active: boolean;
  readonly closed: boolean;
  readonly endDate?: string;
  readonly outcomePrices?: ReadonlyArray<string>;
  readonly volume?: string;
  readonly liquidity?: string;
  /** Display only — never used to sign. */
  readonly fees?: { readonly makerBaseFee?: number; readonly takerBaseFee?: number };
};

export type PolymarketEvent = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly negRisk?: boolean;
  readonly endDate?: string;
  readonly markets: ReadonlyArray<PolymarketMarket>;
};

export type PolymarketBook = {
  readonly assetId: string;
  readonly conditionId: string;
  readonly version: "v1" | "v2";
  /** Sorted by price descending. */
  readonly bids: ReadonlyArray<{ readonly price: string; readonly size: string }>;
  /** Sorted by price ascending. */
  readonly asks: ReadonlyArray<{ readonly price: string; readonly size: string }>;
  readonly tickSize: string;
  readonly minOrderSize: string;
  readonly negRisk: boolean;
  readonly timestamp: string;
  readonly hash: string;
};

export type PolymarketClobMarket = {
  readonly conditionId?: string;
  readonly tokens: ReadonlyArray<{ readonly assetId: string; readonly outcome?: string }>;
  readonly minOrderSize?: string;
  readonly tickSize?: string;
  readonly acceptingOrders?: boolean;
  /** The market only accepts buy orders against its closing book. */
  readonly buyOnly?: boolean;
  readonly version: "v1" | "v2";
  readonly blockaidEnabled?: boolean;
  readonly rewards?: {
    readonly enabled?: boolean;
    readonly minIncentiveSize?: string;
    readonly maxIncentiveRate?: string;
    readonly minOrderAgeSec?: number;
  };
};

export type PolymarketPricePoint = { readonly t: number; readonly p: string };

export type PolymarketResolution = {
  readonly conditionId?: string;
  readonly questionId?: string;
  readonly status: string;
  readonly resolved: boolean;
  readonly marketType?: string;
  readonly reporter?: string;
  readonly wasDisputed: boolean;
  readonly extendedReview: boolean;
  readonly resolvedAt?: string;
  /** Micro-USDC per share, `[outcome0, outcome1]`, on resolved rows. */
  readonly payouts?: ReadonlyArray<number>;
  readonly price?: string;
};

export type PolymarketEventsParams = {
  readonly limit?: number;
  readonly offset?: number;
  readonly closed?: boolean;
  readonly order?: string;
  readonly ascending?: boolean;
  readonly tag_id?: number;
};

export type PolymarketHistoryParams = {
  readonly startTs?: number;
  readonly endTs?: number;
  readonly interval?: "max" | "all" | "1m" | "1w" | "1d" | "6h" | "1h";
  readonly fidelity?: number;
};

export type PolymarketMarkets = {
  readonly events: (params?: PolymarketEventsParams) => Promise<ReadonlyArray<PolymarketEvent>>;
  readonly event: (slug: string) => Promise<PolymarketEvent>;
  readonly markets: (params?: PolymarketEventsParams) => Promise<ReadonlyArray<PolymarketMarket>>;
  readonly market: (slug: string) => Promise<PolymarketMarket>;
  readonly search: (query: string) => Promise<ReadonlyArray<PolymarketEvent>>;
  readonly book: (assetId: string) => Promise<PolymarketBook>;
  readonly price: (assetId: string, side: "BUY" | "SELL") => Promise<string>;
  readonly midpoint: (assetId: string) => Promise<string>;
  readonly history: (
    assetId: string,
    params?: PolymarketHistoryParams,
  ) => Promise<ReadonlyArray<PolymarketPricePoint>>;
  readonly clobMarket: (conditionId: string) => Promise<PolymarketClobMarket>;
  readonly feeRate: (assetId: string) => Promise<number>;
  readonly resolution: (conditionId: string) => Promise<ReadonlyArray<PolymarketResolution>>;
  readonly time: () => Promise<PolymarketServerTime>;
};

const EVENTS_LIMIT = 100;

const malformed = (where: string, what: string): PolymarketError =>
  new PolymarketError("malformed", `${where}: ${what}`);

/** A Gamma JSON-text field: a strict JSON array, every item run through `check`. */
const jsonArray = <T>(text: string, check: (value: unknown) => value is T, where: string): T[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed(where, "field is not JSON text");
  }
  if (!Array.isArray(parsed) || parsed.length > 64 || !parsed.every(check)) {
    throw malformed(where, "field is not the expected JSON array");
  }
  return parsed;
};

const isString = (value: unknown): value is string => typeof value === "string";
const isUint256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{1,78}$/.test(value);

type GammaMarket = z.output<typeof gammaMarket>;
type GammaEvent = z.output<typeof gammaEvent>;

const normalizeMarket = (raw: GammaMarket): PolymarketMarket => {
  const outcomes = jsonArray(raw.outcomes, isString, `market ${raw.id} outcomes`);
  const version = raw.version === "v2" ? "v2" : "v1";
  /* v2 names the ERC-1155 position ids; v1 trades the parsed clobTokenIds (research.md §5). */
  const assetIds =
    version === "v2"
      ? (raw.positionIds ?? []).filter(isUint256)
      : raw.clobTokenIds === undefined || raw.clobTokenIds === null
        ? (() => {
            throw malformed(`market ${raw.id}`, "v1 market has no clobTokenIds");
          })()
        : jsonArray(raw.clobTokenIds, isUint256, `market ${raw.id} clobTokenIds`);
  if (version === "v2" && assetIds.length === 0) {
    throw malformed(`market ${raw.id}`, "v2 market has no positionIds");
  }
  if (assetIds.length !== outcomes.length) {
    throw malformed(`market ${raw.id}`, "asset id count does not match outcomes");
  }
  const outcomePrices =
    raw.outcomePrices === undefined || raw.outcomePrices === null
      ? undefined
      : jsonArray(raw.outcomePrices, isString, `market ${raw.id} outcomePrices`);
  const questionId = raw.questionID ?? raw.questionId ?? undefined;
  return {
    id: raw.id,
    conditionId: raw.conditionId,
    ...(questionId === undefined || questionId === null ? {} : { questionId }),
    question: raw.question ?? "",
    slug: raw.slug,
    outcomes,
    assetIds,
    version,
    negRisk: raw.negRisk ?? false,
    tickSize: raw.orderPriceMinTickSize ?? "0.01",
    minOrderSize: raw.orderMinSize ?? "1",
    acceptingOrders: raw.acceptingOrders ?? false,
    active: raw.active ?? false,
    closed: raw.closed ?? false,
    ...(raw.endDate === undefined || raw.endDate === null ? {} : { endDate: raw.endDate }),
    ...(outcomePrices === undefined ? {} : { outcomePrices }),
    ...(raw.volume === undefined || raw.volume === null ? {} : { volume: raw.volume }),
    ...(raw.liquidity === undefined || raw.liquidity === null ? {} : { liquidity: raw.liquidity }),
    ...(raw.makerBaseFee === undefined && raw.takerBaseFee === undefined
      ? {}
      : {
          fees: {
            ...(raw.makerBaseFee === undefined || raw.makerBaseFee === null
              ? {}
              : { makerBaseFee: raw.makerBaseFee }),
            ...(raw.takerBaseFee === undefined || raw.takerBaseFee === null
              ? {}
              : { takerBaseFee: raw.takerBaseFee }),
          },
        }),
  };
};

const normalizeEvent = (raw: GammaEvent): PolymarketEvent => ({
  id: raw.id,
  slug: raw.slug,
  title: raw.title ?? "",
  active: raw.active ?? false,
  closed: raw.closed ?? false,
  ...(raw.negRisk === undefined || raw.negRisk === null ? {} : { negRisk: raw.negRisk }),
  ...(raw.endDate === undefined || raw.endDate === null ? {} : { endDate: raw.endDate }),
  markets: (raw.markets ?? []).map(normalizeMarket),
});

type ResolutionRow = z.output<typeof dataResolutions>["data"][number];

const normalizeResolution = (row: ResolutionRow): PolymarketResolution => ({
  ...(row.condition_id === undefined || row.condition_id === null
    ? {}
    : { conditionId: row.condition_id }),
  ...(row.question_id === undefined || row.question_id === null
    ? {}
    : { questionId: row.question_id }),
  status: row.status,
  resolved: row.status === "resolved",
  ...(row.market_type === undefined || row.market_type === null
    ? {}
    : { marketType: row.market_type }),
  ...(row.reporter === undefined || row.reporter === null ? {} : { reporter: row.reporter }),
  wasDisputed: row.was_disputed,
  extendedReview: row.extended_review,
  ...(row.resolved_at === undefined || row.resolved_at === null
    ? {}
    : { resolvedAt: row.resolved_at }),
  ...(row.payouts === undefined || row.payouts === null ? {} : { payouts: row.payouts }),
  ...(row.price === undefined || row.price === null ? {} : { price: row.price }),
});

const eventsQuery = (
  params: PolymarketEventsParams | undefined,
): Record<string, string | number | boolean> => {
  if (params === undefined) {
    return {};
  }
  if (
    params.limit !== undefined &&
    (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > EVENTS_LIMIT)
  ) {
    throw new PolymarketError("invalid-input", `limit must be an integer in 1..${EVENTS_LIMIT}`);
  }
  return {
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.offset === undefined ? {} : { offset: params.offset }),
    ...(params.closed === undefined ? {} : { closed: params.closed }),
    ...(params.order === undefined ? {} : { order: params.order }),
    ...(params.ascending === undefined ? {} : { ascending: params.ascending }),
    ...(params.tag_id === undefined ? {} : { tag_id: params.tag_id }),
  };
};

const byPrice = (a: { price: string }, b: { price: string }): number =>
  Number(a.price) - Number(b.price);

export function createPolymarketMarkets(http: PolymarketHttp): PolymarketMarkets {
  return {
    events: async (params) => {
      const rows = await http.request(
        { host: GAMMA_HOST, method: "GET", path: "/events", query: eventsQuery(params) },
        gammaEventList,
      );
      return rows.map(normalizeEvent);
    },

    event: async (slug) =>
      normalizeEvent(
        await http.request(
          { host: GAMMA_HOST, method: "GET", path: `/events/slug/${slug}` },
          gammaEvent,
        ),
      ),

    markets: async (params) => {
      const rows = await http.request(
        { host: GAMMA_HOST, method: "GET", path: "/markets", query: eventsQuery(params) },
        gammaMarketList,
      );
      return rows.map(normalizeMarket);
    },

    market: async (slug) =>
      normalizeMarket(
        await http.request(
          { host: GAMMA_HOST, method: "GET", path: `/markets/slug/${slug}` },
          gammaMarket,
        ),
      ),

    search: async (query) => {
      const found = await http.request(
        { host: GAMMA_HOST, method: "GET", path: "/public-search", query: { q: query } },
        gammaSearch,
      );
      return (found.events ?? []).map(normalizeEvent);
    },

    book: async (assetId) => {
      const raw = await http.request(
        { host: CLOB_HOST, method: "GET", path: "/book", query: { token_id: assetId } },
        clobBook,
      );
      return {
        assetId: raw.asset_id,
        conditionId: raw.market,
        version: raw.version === "v2" ? "v2" : "v1",
        bids: [...raw.bids].sort((a, b) => byPrice(b, a)),
        asks: [...raw.asks].sort(byPrice),
        tickSize: raw.tick_size,
        minOrderSize: raw.min_order_size,
        negRisk: raw.neg_risk,
        timestamp: raw.timestamp,
        hash: raw.hash,
      };
    },

    price: async (assetId, side) => {
      const raw = await http.request(
        {
          host: CLOB_HOST,
          method: "GET",
          path: "/price",
          query: { token_id: assetId, side },
        },
        clobPrice,
      );
      return raw.price;
    },

    midpoint: async (assetId) => {
      const raw = await http.request(
        { host: CLOB_HOST, method: "GET", path: "/midpoint", query: { token_id: assetId } },
        clobMidpoint,
      );
      return raw.mid;
    },

    history: async (assetId, params) => {
      const raw = await http.request(
        {
          host: CLOB_HOST,
          method: "GET",
          path: "/prices-history",
          query: {
            market: assetId,
            ...(params?.startTs === undefined ? {} : { startTs: params.startTs }),
            ...(params?.endTs === undefined ? {} : { endTs: params.endTs }),
            ...(params?.interval === undefined ? {} : { interval: params.interval }),
            ...(params?.fidelity === undefined ? {} : { fidelity: params.fidelity }),
          },
        },
        clobPricesHistory,
      );
      return raw.history;
    },

    clobMarket: async (condition) => {
      const raw = await http.request(
        {
          host: CLOB_HOST,
          method: "GET",
          path: `/clob-markets/${condition}`,
        },
        clobMarketDetails,
      );
      return {
        ...(raw.c === undefined || raw.c === null ? {} : { conditionId: raw.c }),
        tokens: raw.t.map((token) => ({
          assetId: token.t,
          ...(token.o === undefined || token.o === null ? {} : { outcome: token.o }),
        })),
        ...(raw.mos === undefined || raw.mos === null ? {} : { minOrderSize: raw.mos }),
        ...(raw.mts === undefined || raw.mts === null ? {} : { tickSize: raw.mts }),
        ...(raw.ao === undefined || raw.ao === null ? {} : { acceptingOrders: raw.ao }),
        ...(raw.cbos === undefined || raw.cbos === null ? {} : { buyOnly: raw.cbos }),
        version: raw.v === "v2" ? "v2" : "v1",
        ...(raw.ibce === undefined || raw.ibce === null ? {} : { blockaidEnabled: raw.ibce }),
        ...(raw.r === undefined || raw.r === null
          ? {}
          : {
              rewards: {
                ...(raw.r.e === undefined || raw.r.e === null ? {} : { enabled: raw.r.e }),
                ...(raw.r.mi === undefined || raw.r.mi === null
                  ? {}
                  : { minIncentiveSize: raw.r.mi }),
                ...(raw.r.ma === undefined || raw.r.ma === null
                  ? {}
                  : { maxIncentiveRate: raw.r.ma }),
                ...(raw.r.moas === undefined || raw.r.moas === null
                  ? {}
                  : { minOrderAgeSec: raw.r.moas }),
              },
            }),
      };
    },

    feeRate: async (assetId) => {
      const raw = await http.request(
        { host: CLOB_HOST, method: "GET", path: "/fee-rate", query: { token_id: assetId } },
        clobFeeRate,
      );
      return raw.base_fee;
    },

    resolution: async (condition) => {
      const raw = await http.request(
        { host: DATA_HOST, method: "GET", path: "/v2/resolutions", query: { condition } },
        dataResolutions,
      );
      return raw.data.map(normalizeResolution);
    },

    time: http.time,
  };
}
