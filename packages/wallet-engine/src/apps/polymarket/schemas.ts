/**
 * Zod/mini schemas for the Gamma/CLOB/Data answers the provider reads (design.md 不变量 7) — exactly
 * the fields we consume, unknown keys ignored (`looseObject`), bounded lengths so a hostile answer
 * cannot balloon memory. Field shapes follow the archived specs
 * (evidence/specs/{gamma,clob,data-api-v2}-openapi) and the live recordings.
 *
 * Wire quirks handled here: money/price/size fields arrive as numbers OR decimal strings and
 * normalise to strings; Gamma carries `outcomes`/`clobTokenIds`/`outcomePrices` as JSON _text_
 * (parsed strictly in markets.ts — the schema only bounds the string); `version` absent means
 * "v1".
 */
import * as z from "zod/mini";

const MAX_TEXT = 8192;
const MAX_ITEMS = 512;
const MAX_MARKETS = 256;

/** `0x` + 64 hex — a condition/question/order id. */
export const conditionId = z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/));

/** A uint256 as decimal text — token/asset ids. */
export const uint256 = z.string().check(z.regex(/^[0-9]{1,78}$/));

/** Decimal-looking text or a finite number, normalised to its string form. */
export const wireDecimal = z.pipe(
  z.union([z.string().check(z.maxLength(64)), z.number()]),
  z.transform((value) => (typeof value === "number" ? String(value) : value)),
);

const wireDecimalOrNull = z.union([wireDecimal, z.null()]);
const boolOrNull = z.union([z.boolean(), z.null()]);
const textOrNull = z.union([z.string().check(z.maxLength(MAX_TEXT)), z.null()]);

/* ---------------------------------------------------------------- Gamma --- */

/** Specs/gamma-openapi.yaml `Market` — the fields we read, nullable per the spec where noted. */
export const gammaMarket = z.looseObject({
  id: z.string().check(z.maxLength(32)),
  conditionId,
  slug: z.string().check(z.maxLength(512)),
  question: textOrNull,
  /* Live responses carry `questionID`; the spec documents `questionId` — accept either. */
  questionID: z.optional(z.union([conditionId, z.null()])),
  questionId: z.optional(z.union([conditionId, z.null()])),
  /* `["A","B"]` as JSON text — parsed strictly in markets.ts. */
  outcomes: z.string().check(z.maxLength(MAX_TEXT)),
  clobTokenIds: z.optional(textOrNull),
  positionIds: z.optional(z.union([z.array(uint256).check(z.maxLength(16)), z.null()])),
  version: z.optional(textOrNull),
  /* Closed markets omit the status flags entirely — everything normalizes off `?? false`. */
  negRisk: z.optional(boolOrNull),
  orderPriceMinTickSize: z.optional(wireDecimalOrNull),
  orderMinSize: z.optional(wireDecimalOrNull),
  acceptingOrders: z.optional(boolOrNull),
  active: z.optional(boolOrNull),
  closed: z.optional(boolOrNull),
  endDate: z.optional(z.union([z.string().check(z.maxLength(64)), z.null()])),
  outcomePrices: z.optional(textOrNull),
  volume: z.optional(wireDecimalOrNull),
  liquidity: z.optional(wireDecimalOrNull),
  makerBaseFee: z.optional(z.union([z.number(), z.null()])),
  takerBaseFee: z.optional(z.union([z.number(), z.null()])),
});

export const gammaMarketList = z.array(gammaMarket).check(z.maxLength(MAX_MARKETS));

/** Specs/gamma-openapi.yaml `Event` — `markets` embeds full Market rows. */
export const gammaEvent = z.looseObject({
  id: z.string().check(z.maxLength(32)),
  slug: z.string().check(z.maxLength(512)),
  title: textOrNull,
  active: z.optional(boolOrNull),
  closed: z.optional(boolOrNull),
  negRisk: z.optional(boolOrNull),
  endDate: z.optional(z.union([z.string().check(z.maxLength(64)), z.null()])),
  markets: z.optional(z.union([gammaMarketList, z.null()])),
});

export const gammaEventList = z.array(gammaEvent).check(z.maxLength(MAX_ITEMS));

/** `/public-search` `Search` — events only; tags/profiles are ignored. */
export const gammaSearch = z.looseObject({
  events: z.optional(z.union([gammaEventList, z.null()])),
});

/* ----------------------------------------------------------------- CLOB --- */

const orderSummary = z.looseObject({
  price: z.string().check(z.maxLength(32)),
  size: z.string().check(z.maxLength(64)),
});

/** `OrderBookSummary` — bids desc / asks asc per the spec; markets.ts re-sorts defensively. */
export const clobBook = z.looseObject({
  market: conditionId,
  asset_id: uint256,
  timestamp: z.string().check(z.maxLength(32)),
  hash: z.string().check(z.maxLength(128)),
  bids: z.array(orderSummary).check(z.maxLength(MAX_ITEMS)),
  asks: z.array(orderSummary).check(z.maxLength(MAX_ITEMS)),
  min_order_size: wireDecimal,
  tick_size: wireDecimal,
  neg_risk: z.boolean(),
  last_trade_price: z.optional(wireDecimalOrNull),
  version: z.optional(textOrNull),
});

export const clobPrice = z.looseObject({ price: wireDecimal });

/** The spec documents `mid_price`; the live key is `mid` (recording `midpoint-primary.json`). */
export const clobMidpoint = z.looseObject({ mid: wireDecimal });

export const clobFeeRate = z.looseObject({ base_fee: z.number() });

export const clobPricesHistory = z.looseObject({
  history: z
    .array(
      z.looseObject({
        t: z.number(),
        p: wireDecimal,
      }),
    )
    .check(z.maxLength(10_000)),
});

const clobToken = z.looseObject({ t: uint256, o: z.optional(textOrNull) });

/**
 * `ClobMarketDetails` — live abbreviated keys (recording `clob-market-primary.json`): `c`
 * conditionId, `t` tokens, `mos`/`mts` order minimums, `ao` accepting orders, `cbos` closed
 * buy-only, `aot` accepting-orders timestamp, `ibce` Blockaid check, `v` version, `r` rewards (`e`
 * enabled, `mi`/`ma` incentive bounds, `moas` min order age). The archived spec's
 * `mbf`/`tbf`/`rfqe`/`itode`/`oas` fields do not appear on live answers.
 */
const clobRewards = z.looseObject({
  e: z.optional(boolOrNull),
  mi: z.optional(wireDecimalOrNull),
  ma: z.optional(wireDecimalOrNull),
  moas: z.optional(z.union([z.number(), z.null()])),
});

export const clobMarketDetails = z.looseObject({
  c: z.optional(z.union([conditionId, z.null()])),
  t: z.array(clobToken).check(z.maxLength(16)),
  mos: z.optional(wireDecimalOrNull),
  mts: z.optional(wireDecimalOrNull),
  ao: z.optional(boolOrNull),
  cbos: z.optional(boolOrNull),
  aot: z.optional(textOrNull),
  ibce: z.optional(boolOrNull),
  r: z.optional(z.union([clobRewards, z.null()])),
  v: z.optional(textOrNull),
});

/* ----------------------------------------------------------------- Data --- */

/** `/v2/resolutions` rows — UMA/V2 lifecycle fields; `payouts` in micro-USDC per share. */
const resolutionRow = z.looseObject({
  condition_id: z.optional(z.union([conditionId, z.null()])),
  question_id: z.optional(z.union([conditionId, z.null()])),
  status: z.string().check(z.maxLength(32)),
  market_type: z.optional(textOrNull),
  reporter: z.optional(textOrNull),
  was_disputed: z.boolean(),
  extended_review: z.boolean(),
  resolved_at: z.optional(z.union([z.string().check(z.maxLength(64)), z.null()])),
  payouts: z.optional(z.union([z.array(z.number()).check(z.maxLength(16)), z.null()])),
  price: z.optional(wireDecimalOrNull),
});

export const dataResolutions = z.looseObject({
  data: z.array(resolutionRow).check(z.maxLength(64)),
});
