/* The scheme's strict validators — the network scope and the wire params over the ten
   allow-listed action schemas (research H2-T); a failure inside `document` answers
   `invalid-input`. */
import { arr, bool, int, literal, obj, opt, str, union } from "@qntx/wallet/protocol";
import type {
  HyperliquidAgentLimits,
  HyperliquidL1Action,
  HyperliquidL1Order,
  HyperliquidL1Params,
  HyperliquidNetwork,
  Validator,
} from "@qntx/wallet/protocol";

export const hyperliquidNetwork: Validator<HyperliquidNetwork> = union(
  literal("Mainnet"),
  literal("Testnet"),
);

const lowerAddress = str(42, /^0x[0-9a-f]{40}$/);
const safeTime = int(0, Number.MAX_SAFE_INTEGER);

/** A positive canonical decimal (nktkas's normalised output) — prices, sizes, trigger prices. */
export const positive: Validator<string> = str(
  24,
  /^(?:[1-9][0-9]{0,14}(?:\.[0-9]{0,7}[1-9])?|0\.[0-9]{0,7}[1-9])$/,
);
const cloid = str(34, /^0x[0-9a-f]{32}$/);
const asset = int(0, 4294967295);
const id = int(0, 9007199254740991);

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

const oid = union(id, cloid);

/* Every action is an exact-key object; unknown `type` or extra keys fail. `grouping` admits only
   the free groupings — `{p}` is a priority fee of up to 100 % of notional (nktkas order.ts:69-84)
   — and builder `s` splits are not accepted. `twapOrder` is not admitted: a TWAP's slices carry
   no price the kernel could meter against the session budget. */
export const hyperliquidL1Action: Validator<HyperliquidL1Action> = union(
  obj({
    type: literal("order"),
    orders: arr(orderWire, 64, 1),
    grouping: union(literal("na"), literal("normalTpsl"), literal("positionTpsl")),
    builder: opt(obj({ b: lowerAddress, f: int(0, 1000) })),
  }),
  obj({
    type: literal("cancel"),
    cancels: arr(obj({ a: asset, o: id }), 64, 1),
    f: opt(literal(true)),
  }),
  obj({
    type: literal("cancelByCloid"),
    cancels: arr(obj({ asset, cloid }), 64, 1),
    f: opt(literal(true)),
  }),
  obj({
    type: literal("modify"),
    oid,
    order: orderWire,
    a: opt(literal(true)),
  }),
  obj({
    type: literal("batchModify"),
    modifies: arr(obj({ oid, order: orderWire }), 64, 1),
    a: opt(literal(true)),
  }),
  obj({ type: literal("scheduleCancel"), time: opt(id) }),
  obj({ type: literal("updateLeverage"), asset, isCross: bool, leverage: int(1, 1000) }),
  obj({
    type: literal("updateIsolatedMargin"),
    asset,
    isBuy: bool,
    ntli: int(-9007199254740991, 9007199254740991),
  }),
  obj({ type: literal("twapCancel"), a: asset, t: id }),
);

/** The params `sessions.sign` takes for this scheme — `expiresAfter` is required. */
export const hyperliquidL1Params: Validator<HyperliquidL1Params> = obj({
  action: hyperliquidL1Action,
  nonce: safeTime,
  vaultAddress: opt(lowerAddress),
  expiresAfter: safeTime,
});

/* 1..16 asset ids, strictly ascending — an unsorted or duplicated list is a different commitment
   than the one the prompt shows, so it is refused rather than reordered. Ids stay below 100000:
   builder-deployed (HIP-3) perps live at `100000 + dex_index*10000 + index`
   (@nktkas/hyperliquid utils/_symbolConverter.js) and the engine leaves them out of scope, so
   an approved list can never contain one — a charged order outside the list is limit-exceeded. */
const assetList: Validator<ReadonlyArray<number>> = (value) => {
  const list = arr(int(0, 99_999), 16, 1)(value);
  let prev = -1;
  for (const entry of list) {
    if (entry <= prev) {
      throw new Error("assets must be sorted and distinct");
    }
    prev = entry;
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
