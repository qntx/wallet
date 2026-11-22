/**
 * The strict validators of the hyperliquid-l1-agent scheme — the network scope and the wire params
 * with the ten allow-listed action schemas (research H2-T). They moved into the kernel with the
 * scheme: the main runtime does not need them, and a failure inside `document` answers
 * `invalid-input`.
 */
import { arr, bool, int, literal, obj, opt, str, union } from "@qntx/wallet/protocol";
import type {
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
const positive = str(24, /^(?:[1-9][0-9]{0,14}(?:\.[0-9]{0,7}[1-9])?|0\.[0-9]{0,7}[1-9])$/);
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

/**
 * The strict wire validator: every action is an exact-key object; unknown `type` or extra keys
 * fail. `grouping` admits only the free groupings — `{p}` is a priority fee of up to 100 % of
 * notional (nktkas order.ts:69-84) — and builder `s` splits are not accepted; twapOrder's optional
 * `details` is rejected too.
 */
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
  obj({
    type: literal("twapOrder"),
    twap: obj({ a: asset, b: bool, s: positive, r: bool, m: int(5, 1440), t: bool }),
  }),
  obj({ type: literal("twapCancel"), a: asset, t: id }),
);

/** The params `sessions.sign` takes for this scheme — `expiresAfter` is optional on the wire. */
export const hyperliquidL1Params: Validator<HyperliquidL1Params> = obj({
  action: hyperliquidL1Action,
  nonce: safeTime,
  vaultAddress: opt(lowerAddress),
  expiresAfter: opt(safeTime),
});
