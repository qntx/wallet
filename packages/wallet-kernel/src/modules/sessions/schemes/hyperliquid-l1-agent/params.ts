/* The scheme's strict validators — the network scope and the wire params over the nine
   allow-listed action schemas (research H2-T); a failure inside `document` answers
   `invalid-input`. */
import { arr, bool, int, literal, obj, opt, str, union } from "@qntx/wallet/protocol";
import type {
  HyperliquidAgentLimits,
  HyperliquidAgentSpent,
  HyperliquidAssetLimit,
  HyperliquidL1Action,
  HyperliquidL1Order,
  HyperliquidL1Params,
  HyperliquidNetwork,
  Validator,
} from "@qntx/wallet/protocol";

import { decimalToUnits } from "../../../../decimal.ts";

export const hyperliquidNetwork: Validator<HyperliquidNetwork> = union(
  literal("Mainnet"),
  literal("Testnet"),
);

const lowerAddress = str(42, /^0x[0-9a-f]{40}$/);
const safeInt = int(0, Number.MAX_SAFE_INTEGER);

/** A positive canonical decimal (nktkas's normalised output) — prices, sizes, trigger prices. */
export const positive: Validator<string> = str(
  24,
  /^(?:[1-9][0-9]{0,14}(?:\.[0-9]{0,7}[1-9])?|0\.[0-9]{0,7}[1-9])$/,
);
const cloid = str(34, /^0x[0-9a-f]{32}$/);
const asset = int(0, 4294967295);
const flag = opt(literal(true));
const list = <T>(item: Validator<T>): Validator<ReadonlyArray<T>> => arr(item, 64, 1);

const orderType = union(
  obj({
    limit: obj({
      tif: union(literal("Gtc"), literal("Ioc"), literal("Alo"), literal("FrontendMarket")),
    }),
  }),
  obj({
    trigger: obj({
      isMarket: bool,
      triggerPx: positive,
      tpsl: union(literal("tp"), literal("sl")),
    }),
  }),
);

const orderWire: Validator<HyperliquidL1Order> = obj({
  a: asset,
  b: bool,
  p: positive,
  s: positive,
  r: bool,
  t: orderType,
  c: opt(cloid),
});

const oid = union(safeInt, cloid);

/* Every action is an exact-key object; unknown `type` or extra keys fail. `grouping` admits only
   the free groupings — `{p}` is a priority fee of up to 100 % of notional (nktkas order.ts:69-84)
   — and builder `s` splits are not accepted. `twapOrder` is not admitted: a TWAP's slices carry
   no price the kernel could meter against the session budget. `scheduleCancel` is not admitted:
   it cancels every open order on every asset, so no allow-list could scope it. */
export const hyperliquidL1Action: Validator<HyperliquidL1Action> = union(
  obj({
    type: literal("order"),
    orders: list(orderWire),
    grouping: union(literal("na"), literal("normalTpsl"), literal("positionTpsl")),
    builder: opt(obj({ b: lowerAddress, f: int(0, 1000) })),
  }),
  obj({
    type: literal("cancel"),
    cancels: list(obj({ a: asset, o: safeInt })),
    f: flag,
  }),
  obj({
    type: literal("cancelByCloid"),
    cancels: list(obj({ asset, cloid })),
    f: flag,
  }),
  obj({
    type: literal("modify"),
    oid,
    order: orderWire,
    a: flag,
  }),
  obj({
    type: literal("batchModify"),
    modifies: list(obj({ oid, order: orderWire })),
    a: flag,
  }),
  obj({ type: literal("updateLeverage"), asset, isCross: bool, leverage: int(1, 1000) }),
  obj({
    type: literal("updateIsolatedMargin"),
    asset,
    isBuy: bool,
    ntli: int(-9007199254740991, 9007199254740991),
  }),
  obj({ type: literal("twapCancel"), a: asset, t: safeInt }),
);

/** The params `sessions.sign` takes for this scheme — `expiresAfter` is required. */
export const hyperliquidL1Params: Validator<HyperliquidL1Params> = obj({
  action: hyperliquidL1Action,
  nonce: safeInt,
  vaultAddress: opt(lowerAddress),
  expiresAfter: safeInt,
});

/* 1..16 {asset, size} entries, strictly ascending by asset — an unsorted or duplicated list is a
   different commitment than the one the prompt shows, so it is refused rather than reordered. Ids
   stay below 100000: builder-deployed (HIP-3) perps live at `100000 + dex_index*10000 + index`
   (@nktkas/hyperliquid utils/_symbolConverter.js) and the engine leaves them out of scope, so
   an approved list can never contain one — a charged order outside the list is limit-exceeded.
   `size` is the cumulative quantity buys and sells on that asset may charge in total. */
const assetList: Validator<ReadonlyArray<HyperliquidAssetLimit>> = (value) => {
  const list = arr(obj({ asset: int(0, 99_999), size: positive }), 16, 1)(value);
  let prev = -1;
  for (const entry of list) {
    if (entry.asset <= prev) {
      throw new Error("assets must be sorted and distinct");
    }
    prev = entry.asset;
  }
  return list;
};

/* `notional` shares the order's `positive` grammar (canonical, ≤ 1e15), `maxLeverage` caps
   `updateLeverage`, `assets` is the sorted allow-list every charged action must stay within. */
export const hyperliquidL1Limits: Validator<HyperliquidAgentLimits> = obj({
  notional: positive,
  maxLeverage: int(1, 100),
  assets: assetList,
});

/* A canonical non-negative decimal — the grammar the record's `spent` uses. The `positive` params
   grammar admits at most eight fractional digits, so a buy charge (price × size) is exact at
   sixteen; the integer part is bounded by the ~1e15 budgets spent can never exceed. */
const canonical = str(32, /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{0,15}[1-9])?$/);

/* The stored metering, strict against the limits: exact keys, `notional` canonical and within the
   buy budget, `size` parallel to `limits.assets` with each entry canonical and within that asset's
   cap. Anything else is a tampered record — the sessions handlers answer latched `integrity`. */
export const hyperliquidL1Spent = (
  value: unknown,
  limits: HyperliquidAgentLimits,
): HyperliquidAgentSpent => {
  const spent = obj({
    notional: canonical,
    size: arr(canonical, limits.assets.length, limits.assets.length),
  })(value);
  if (decimalToUnits(spent.notional) > decimalToUnits(limits.notional)) {
    throw new Error("spent exceeds the buy budget");
  }
  for (const [i, cap] of limits.assets.entries()) {
    if (decimalToUnits(spent.size[i] ?? "0") > decimalToUnits(cap.size)) {
      throw new Error("spent exceeds an asset's cap");
    }
  }
  return spent;
};

/** The all-zero metering a fresh record is sealed with — one size slot per limits entry. */
export const hyperliquidFreshSpent = (limits: HyperliquidAgentLimits): HyperliquidAgentSpent => ({
  notional: "0",
  size: limits.assets.map(() => "0"),
});

/* The open prompt's remaining buy budget renders `limits.notional - spent.notional`; the smallest
   charge the grammar admits leaves a remainder with the longest rendering the limits can produce
   (up to 15 integer and 16 fractional digits) — what create's prompt-fit check must fit. */
export const hyperliquidWorstSpent = (limits: HyperliquidAgentLimits): HyperliquidAgentSpent => ({
  ...hyperliquidFreshSpent(limits),
  notional: "0.0000000000000001",
});
