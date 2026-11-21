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

/* ------------------------------------------------------------- account --- */

/** `0x` + 40 hex — an EVM address; the output keeps the template type. */
export const evmAddress = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
);

/** Relayer `GET /deployed` — the only field the locate step reads. */
export const relayerDeployed = z.looseObject({ deployed: z.boolean() });

/** The Data-v2 paged envelope — `next_cursor` is the only page token callers follow. */
const dataPagination = z.looseObject({
  has_more: z.boolean(),
  next_cursor: z.optional(z.union([z.string().check(z.maxLength(4096)), z.null()])),
});

/**
 * `/v2/positions` rows (specs/data-api-v2-openapi.json `Position`, plus the live record
 * `account-positions.json`): money/size/PnL fields are numbers on the wire and normalise to strings
 * — a `null` numeric means unavailable, never zero.
 */
export const dataPosition = z.looseObject({
  proxy_wallet: evmAddress,
  token_id: uint256,
  condition_id: conditionId,
  current_size: wireDecimal,
  avg_price: z.optional(wireDecimalOrNull),
  entry_cost_usdc: z.optional(wireDecimalOrNull),
  entry_fees_usdc: z.optional(wireDecimalOrNull),
  total_cost_usdc: z.optional(wireDecimalOrNull),
  current_price: z.optional(wireDecimalOrNull),
  current_value: z.optional(wireDecimalOrNull),
  total_size: z.optional(wireDecimalOrNull),
  realized_pnl: z.optional(wireDecimalOrNull),
  unrealized_pnl: z.optional(wireDecimalOrNull),
  total_pnl: z.optional(wireDecimalOrNull),
  percent_pnl: z.optional(wireDecimalOrNull),
  percent_realized_pnl: z.optional(wireDecimalOrNull),
  status: z.string().check(z.maxLength(32)),
  redeemable: z.optional(boolOrNull),
  mergeable: z.optional(boolOrNull),
  negative_risk: z.optional(boolOrNull),
  archived: z.optional(boolOrNull),
  title: z.optional(textOrNull),
  slug: z.optional(textOrNull),
  outcome: z.optional(textOrNull),
  outcome_index: z.optional(z.union([z.number(), z.null()])),
  opposite_outcome: z.optional(textOrNull),
  opposite_token_id: z.optional(z.union([uint256, z.null()])),
  end_date: z.optional(z.union([z.string().check(z.maxLength(64)), z.null()])),
});

export const dataPositions = z.looseObject({
  data: z.array(dataPosition).check(z.maxLength(MAX_ITEMS)),
  pagination: dataPagination,
});

/** `/v2/value` — exactly one row; an empty book still answers `{proxy_wallet, value: 0}`. */
export const dataValue = z.looseObject({
  data: z.looseObject({ proxy_wallet: evmAddress, value: wireDecimal }),
});

/** `/v2/activity` rows — the feed fields the account view reads. */
export const dataActivityItem = z.looseObject({
  proxy_wallet: evmAddress,
  timestamp: z.number(),
  condition_id: z.string().check(z.maxLength(128)),
  type: z.string().check(z.maxLength(32)),
  size: z.optional(wireDecimalOrNull),
  usdc_size: z.optional(wireDecimalOrNull),
  transaction_hash: z.string().check(z.maxLength(128)),
  price: z.optional(wireDecimalOrNull),
  token_id: z.string().check(z.maxLength(128)),
  side: z.optional(z.string().check(z.maxLength(16))),
  outcome_index: z.optional(z.union([z.number(), z.null()])),
  outcome: z.optional(textOrNull),
  title: z.optional(textOrNull),
  slug: z.optional(textOrNull),
});

export const dataActivity = z.looseObject({
  data: z.array(dataActivityItem).check(z.maxLength(MAX_ITEMS)),
  pagination: dataPagination,
});

/** `/v2/user-pnl` — dense cumulative points; nullable atoms mean unavailable, not zero. */
export const dataPnlPoint = z.looseObject({
  timestamp: z.number(),
  source_block: z.optional(z.union([z.number(), z.null()])),
  realized_pnl: wireDecimal,
  position_pnl: z.optional(wireDecimalOrNull),
  economic_pnl: z.optional(wireDecimalOrNull),
  settled_pnl: z.optional(wireDecimalOrNull),
  volume: z.optional(wireDecimalOrNull),
  volume_usdc: z.optional(wireDecimalOrNull),
  trade_count: z.optional(z.union([z.number(), z.null()])),
});

export const dataUserPnl = z.looseObject({
  data: z.looseObject({
    proxy_wallet: evmAddress,
    interval: z.string().check(z.maxLength(16)),
    fidelity: z.string().check(z.maxLength(16)),
    points: z.array(dataPnlPoint).check(z.maxLength(10_000)),
  }),
});

/** `/v2/approvals` — the served catalog of token/operator approvals, canonical order. */
const approvalContract = z.looseObject({
  id: z.string().check(z.maxLength(128)),
  feature: z.string().check(z.maxLength(64)),
  token: evmAddress,
  spender: evmAddress,
  standard: z.string().check(z.maxLength(16)),
  amount: z.optional(z.union([z.string().check(z.maxLength(80)), z.null()])),
  approved: z.boolean(),
});

export const dataApprovals = z.looseObject({
  data: z.looseObject({
    address: evmAddress,
    chain_id: z.number(),
    checked_at: z.string().check(z.maxLength(64)),
    contracts: z.array(approvalContract).check(z.maxLength(128)),
  }),
});

/* ----------------------------------------------------------- CLOB (L2) --- */

const clobBoundedText = z.string().check(z.maxLength(128));

/**
 * `OpenOrder` — the `/data/orders` row and the `/data/order/{id}` answer (specs/clob-openapi.yaml;
 * docs fixture `l2-orders.json`). Sizes/prices arrive as decimal strings already normalised.
 */
export const clobOpenOrder = z.looseObject({
  id: clobBoundedText,
  status: z.string().check(z.maxLength(64)),
  owner: clobBoundedText,
  maker_address: evmAddress,
  market: clobBoundedText,
  asset_id: clobBoundedText,
  side: z.string().check(z.maxLength(8)),
  original_size: z.string().check(z.maxLength(64)),
  size_matched: z.string().check(z.maxLength(64)),
  price: z.string().check(z.maxLength(32)),
  outcome: z.optional(textOrNull),
  expiration: z.string().check(z.maxLength(32)),
  order_type: z.string().check(z.maxLength(8)),
  created_at: z.number(),
});

/** `OrdersResponse` — `next_cursor` is empty when the page is the last. */
export const clobOrdersPage = z.looseObject({
  limit: z.number(),
  next_cursor: z.string().check(z.maxLength(4096)),
  count: z.number(),
  data: z.array(clobOpenOrder).check(z.maxLength(MAX_ITEMS)),
});

const clobMakerOrder = z.looseObject({
  order_id: clobBoundedText,
  owner: z.optional(clobBoundedText),
  maker_address: z.optional(clobBoundedText),
  matched_amount: z.string().check(z.maxLength(64)),
  price: z.string().check(z.maxLength(32)),
  fee_rate_bps: z.optional(z.union([clobBoundedText, z.null()])),
  asset_id: z.optional(clobBoundedText),
  outcome: z.optional(textOrNull),
  side: z.optional(z.string().check(z.maxLength(8))),
});

/** `Trade` — the `/data/trades` row; `maker_orders` may be `[]`. */
export const clobTrade = z.looseObject({
  id: clobBoundedText,
  taker_order_id: clobBoundedText,
  market: clobBoundedText,
  asset_id: clobBoundedText,
  side: z.string().check(z.maxLength(8)),
  size: z.string().check(z.maxLength(64)),
  price: z.string().check(z.maxLength(32)),
  status: z.string().check(z.maxLength(64)),
  match_time: z.string().check(z.maxLength(32)),
  last_update: z.optional(z.union([z.string().check(z.maxLength(32)), z.null()])),
  outcome: z.optional(textOrNull),
  bucket_index: z.optional(z.union([z.number(), z.null()])),
  owner: z.optional(clobBoundedText),
  maker_address: z.optional(clobBoundedText),
  transaction_hash: z.optional(z.union([z.string().check(z.maxLength(128)), z.null()])),
  fee_rate_bps: z.optional(z.union([clobBoundedText, z.null()])),
  err_msg: z.optional(z.union([z.string().check(z.maxLength(512)), z.null()])),
  maker_orders: z.optional(z.union([z.array(clobMakerOrder).check(z.maxLength(64)), z.null()])),
  trader_side: z.string().check(z.maxLength(8)),
});

/** `TradesResponse` — `next_cursor` of `LTE=` (base64 `-1`) means no more pages. */
export const clobTradesPage = z.looseObject({
  limit: z.number(),
  next_cursor: z.string().check(z.maxLength(4096)),
  count: z.number(),
  data: z.array(clobTrade).check(z.maxLength(MAX_ITEMS)),
});

/** `BalanceAllowanceResponse` — `balance`/`allowances` are raw 6-decimal integer strings. */
export const clobBalanceAllowance = z.looseObject({
  balance: z.string().check(z.maxLength(80)),
  allowances: z
    .record(z.string().check(z.maxLength(64)), z.string().check(z.maxLength(80)))
    .check(z.refine((map) => Object.keys(map).length <= 128)),
});

/** `ClosedOnlyResponse` — a 404 (no record) normalises to `false` in account.ts. */
export const clobClosedOnly = z.looseObject({ closed_only: z.boolean() });
