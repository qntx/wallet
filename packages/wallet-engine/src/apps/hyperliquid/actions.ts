import type { HyperliquidL1Action, HyperliquidL1Order } from "@qntx/wallet/protocol";

import { parseDecimal } from "../spi.ts";
import { HyperliquidError } from "./errors.ts";
import type {
  HyperliquidMarkets,
  MetaAndAssetCtxsResponse,
  SpotMetaAndAssetCtxsResponse,
} from "./markets.ts";
import { limitPrice, meetsMinimum, roundSize, slippagePrice } from "./numbers.ts";
import type { HyperliquidMarket, OrderSide } from "./numbers.ts";

/** An asset the main DEX can trade — the wire `a` plus the market's rounding context. */
export type HyperliquidAsset = {
  readonly asset: number;
  readonly szDecimals: number;
  readonly market: HyperliquidMarket;
  readonly maxLeverage?: number;
};

/** TP/SL parameters shared by attached children and standalone trigger orders. */
export type HyperliquidTriggerParams = {
  readonly triggerPx: string;
  /** `true` (default): a market trigger — the fill cap is the slippage price. */
  readonly market?: boolean;
  /** The cap `p` on the wire. Optional for market triggers; required for limit triggers. */
  readonly price?: string;
  /** Cap distance for market triggers without an explicit `price` — required then. */
  readonly slippageBps?: number;
};

/** What kind of order `place` builds. `market` is an IOC limit at a slippage cap. */
export type HyperliquidOrderKind =
  | {
      readonly kind: "limit";
      readonly price: string;
      readonly tif?: "Gtc" | "Ioc" | "Alo";
    }
  | { readonly kind: "market"; readonly slippageBps: number }
  | ({ readonly kind: "trigger"; readonly tpsl: "tp" | "sl" } & HyperliquidTriggerParams);

/** One order to place — the entry; `takeProfit`/`stopLoss` attach reduce-only children. */
export type HyperliquidOrderParams = {
  readonly coin: string;
  readonly side: OrderSide;
  readonly size: string;
  readonly reduceOnly?: boolean;
  readonly order: HyperliquidOrderKind;
  readonly takeProfit?: HyperliquidTriggerParams;
  readonly stopLoss?: HyperliquidTriggerParams;
  /** Position TP/SL: the trigger sizes to the whole position (`positionTpsl` grouping). */
  readonly positionTpsl?: boolean;
};

/** `modify`/`batchModify` change a resting order — no attached children, no grouping. */
export type HyperliquidModifyParams = {
  readonly coin: string;
  readonly side: OrderSide;
  readonly size: string;
  readonly reduceOnly?: boolean;
  readonly order: HyperliquidOrderKind;
};

/** `place` reports the built entry so the caller can show the cap it will post. */
export type HyperliquidPlacedAction = {
  readonly action: HyperliquidL1Action;
  /** The entry order's wire price — for a market order, the slippage cap. */
  readonly price: string;
};

/** Kernel caps action arrays at 64 entries (packages/wallet/src/protocol/apps.ts `arr(.., 64)`). */
const BATCH_CAP = 64;

export const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
};

const cloidOf = (random: (length: number) => Uint8Array): string =>
  `0x${Array.from(random(16), (b) => b.toString(16).padStart(2, "0")).join("")}`;

const isCloid = (value: string): boolean => /^0x[0-9a-f]{32}$/.test(value);

const flip = (side: OrderSide): OrderSide => (side === "buy" ? "sell" : "buy");

/** One wire order: the key order is the kernel schema's (`a,b,p,s,r,t,c`) — hashing order. */
const wireOrder = (order: {
  readonly asset: number;
  readonly side: OrderSide;
  readonly price: string;
  readonly size: string;
  readonly reduceOnly: boolean;
  readonly type: HyperliquidL1Order["t"];
  readonly cloid?: string;
}): HyperliquidL1Order => ({
  a: order.asset,
  b: order.side === "buy",
  p: order.price,
  s: order.size,
  r: order.reduceOnly,
  t: order.type,
  ...(order.cloid === undefined ? {} : { c: order.cloid }),
});

export type HyperliquidActions = {
  /** Coin → wire asset; refreshes meta once on a miss; `{dex}:{coin}` names are out of scope. */
  readonly resolve: (coin: string) => Promise<HyperliquidAsset>;
  readonly place: (params: HyperliquidOrderParams) => Promise<HyperliquidPlacedAction>;
  readonly modify: (
    params: { readonly oid: number | string } & HyperliquidModifyParams,
  ) => Promise<HyperliquidL1Action>;
  readonly batchModify: (
    modifies: ReadonlyArray<{ readonly oid: number | string } & HyperliquidModifyParams>,
  ) => Promise<HyperliquidL1Action>;
  readonly cancel: (
    cancels: ReadonlyArray<{ readonly coin: string; readonly oid: number }>,
  ) => Promise<HyperliquidL1Action>;
  readonly cancelByCloid: (
    cancels: ReadonlyArray<{ readonly coin: string; readonly cloid: string }>,
  ) => Promise<HyperliquidL1Action>;
  /** Pure `cancel` chunks of ≤ 64 entries — `cancelAll` posts one per chunk. */
  readonly cancelBatches: (
    entries: ReadonlyArray<{ readonly a: number; readonly o: number }>,
  ) => ReadonlyArray<HyperliquidL1Action>;
  /* There is no `twap` order builder: a TWAP's slices carry no price the kernel could meter
     against the session's approved budget, so the scheme's validator refuses the action — the
     engine offers only the cancel. */
  readonly twapCancel: (params: {
    readonly coin: string;
    readonly twapId: number;
  }) => Promise<HyperliquidL1Action>;
  readonly setLeverage: (params: {
    readonly coin: string;
    readonly leverage: number;
    readonly marginMode: "cross" | "isolated";
  }) => Promise<HyperliquidL1Action>;
  readonly adjustMargin: (params: {
    readonly coin: string;
    readonly amount: string;
  }) => Promise<HyperliquidL1Action>;
};

/** Orders below the venue's minimum notional are rejected outright — check before signing. */
const checkMinimum = (p: string, s: string): void => {
  if (!meetsMinimum(p, s)) {
    throw new HyperliquidError("invalid-input", "order value is below the 10-quote minimum");
  }
};

/** The wire `t`/`p` for a trigger spec — shared by standalone triggers and TP/SL children. */
const triggerOrder = (
  spec: { readonly tpsl: "tp" | "sl" } & HyperliquidTriggerParams,
  side: OrderSide,
  asset: HyperliquidAsset,
): { readonly p: string; readonly t: HyperliquidL1Order["t"] } => {
  const triggerPx = limitPrice(spec.triggerPx, side, asset.szDecimals, asset.market);
  const isMarket = spec.market !== false;
  let p: string;
  if (spec.price !== undefined) {
    p = limitPrice(spec.price, side, asset.szDecimals, asset.market);
  } else if (isMarket) {
    // Market triggers still cap the fill at triggerPx ± slippage, like the Python SDK's
    // _slippage_price (hyperliquid/exchange.py:112-137, market_close) and MetaMask's TP/SL
    // children (hyperLiquidValidation.ts positionTpsl → trigger × (1 ± slippage)).
    if (spec.slippageBps === undefined) {
      throw new HyperliquidError(
        "invalid-input",
        "a market trigger needs slippageBps or an explicit price",
      );
    }
    p = slippagePrice(triggerPx, side, spec.slippageBps, asset.szDecimals, asset.market);
  } else {
    throw new HyperliquidError("invalid-input", "a limit trigger needs an explicit price");
  }
  return { p, t: { trigger: { isMarket, triggerPx, tpsl: spec.tpsl } } };
};

export function createHyperliquidActions(options: {
  readonly markets: HyperliquidMarkets;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
}): HyperliquidActions {
  let meta: MetaAndAssetCtxsResponse[0] | undefined;
  let spotMeta: SpotMetaAndAssetCtxsResponse[0] | undefined;

  const refreshMeta = async (): Promise<void> => {
    const [perp, spot] = await Promise.all([options.markets.perps(), options.markets.spot()]);
    [meta] = perp;
    [spotMeta] = spot;
  };

  const lookup = (coin: string): HyperliquidAsset | undefined => {
    const perpIndex = meta?.universe.findIndex((entry) => entry.name === coin) ?? -1;
    const perp = perpIndex < 0 ? undefined : meta?.universe[perpIndex];
    if (perp !== undefined) {
      return {
        asset: perpIndex,
        szDecimals: perp.szDecimals,
        market: "perp",
        maxLeverage: perp.maxLeverage,
      };
    }
    const pair = spotMeta?.universe.find((entry) => entry.name === coin);
    const base = pair === undefined ? undefined : spotMeta?.tokens[pair.tokens[0] ?? -1];
    if (pair !== undefined && base !== undefined) {
      // Asset IDs: spot = 10000 + spotInfo["index"], perps = the meta universe index
      // (docs for-developers/api/asset-ids).
      return { asset: 10_000 + pair.index, szDecimals: base.szDecimals, market: "spot" };
    }
    return undefined;
  };

  const resolve = async (coin: string): Promise<HyperliquidAsset> => {
    // Builder-deployed DEXes ("dex:coin") and outcome markets are out of scope (asset-ids doc).
    if (coin.includes(":") || coin.startsWith("#")) {
      throw new HyperliquidError("invalid-input", `${coin} is not a main-DEX market`);
    }
    if (meta === undefined || spotMeta === undefined) {
      await refreshMeta();
    }
    let found = lookup(coin);
    if (found === undefined) {
      await refreshMeta();
      found = lookup(coin);
    }
    if (found === undefined) {
      throw new HyperliquidError("invalid-input", `unknown market ${coin}`);
    }
    return found;
  };

  const mid = async (coin: string): Promise<string> => {
    const mids = await options.markets.mids();
    const price = mids[coin];
    if (price === undefined) {
      throw new HyperliquidError("unavailable", `no mid price for ${coin}`);
    }
    return price;
  };

  /** The wire `t`/`p` for an order kind — market orders price off a fresh mid. */
  const orderType = async (
    coin: string,
    kind: HyperliquidOrderKind,
    side: OrderSide,
    asset: HyperliquidAsset,
  ): Promise<{ readonly p: string; readonly t: HyperliquidL1Order["t"] }> => {
    if (kind.kind === "trigger") {
      return triggerOrder(kind, side, asset);
    }
    if (kind.kind === "market") {
      return {
        p: slippagePrice(await mid(coin), side, kind.slippageBps, asset.szDecimals, asset.market),
        t: { limit: { tif: "Ioc" } },
      };
    }
    return {
      p: limitPrice(kind.price, side, asset.szDecimals, asset.market),
      t: { limit: { tif: kind.tif ?? "Gtc" } },
    };
  };

  const buildOrder = async (
    params: HyperliquidOrderParams,
    tpsl?: "tp" | "sl",
    spec?: HyperliquidTriggerParams,
    child?: { readonly side: OrderSide; readonly size: string },
  ): Promise<{ readonly order: HyperliquidL1Order; readonly price: string }> => {
    const asset = await resolve(params.coin);
    const side = child?.side ?? params.side;
    const size = roundSize(child?.size ?? params.size, asset.szDecimals);
    const { p, t } =
      spec !== undefined && tpsl !== undefined
        ? triggerOrder({ ...spec, tpsl }, side, asset)
        : await orderType(params.coin, params.order, side, asset);
    checkMinimum(p, size);
    return {
      order: wireOrder({
        asset: asset.asset,
        side,
        price: p,
        size,
        reduceOnly: child !== undefined || params.reduceOnly === true,
        type: t,
        cloid: cloidOf(options.random),
      }),
      price: p,
    };
  };

  /** Like {@link buildOrder} for modify/batchModify: the same wire order, no fresh cloid. */
  const buildModifiedOrder = async (
    params: HyperliquidModifyParams,
  ): Promise<HyperliquidL1Order> => {
    const asset = await resolve(params.coin);
    const size = roundSize(params.size, asset.szDecimals);
    const { p, t } = await orderType(params.coin, params.order, params.side, asset);
    checkMinimum(p, size);
    return wireOrder({
      asset: asset.asset,
      side: params.side,
      price: p,
      size,
      reduceOnly: params.reduceOnly === true,
      type: t,
    });
  };

  return {
    resolve,
    place: async (params) => {
      const attached = params.takeProfit !== undefined || params.stopLoss !== undefined;
      if (params.positionTpsl === true && params.order.kind !== "trigger") {
        throw new HyperliquidError("invalid-input", "positionTpsl orders must be trigger orders");
      }
      if (attached && (params.order.kind === "trigger" || params.positionTpsl === true)) {
        throw new HyperliquidError(
          "invalid-input",
          "only an entry order takes attached TP/SL children",
        );
      }
      const entry = await buildOrder(params);
      const orders: HyperliquidL1Order[] = [entry.order];
      if (params.takeProfit !== undefined) {
        const tp = await buildOrder(params, "tp", params.takeProfit, {
          side: flip(params.side),
          size: entry.order.s,
        });
        orders.push(tp.order);
      }
      if (params.stopLoss !== undefined) {
        const sl = await buildOrder(params, "sl", params.stopLoss, {
          side: flip(params.side),
          size: entry.order.s,
        });
        orders.push(sl.order);
      }
      const grouping = attached
        ? "normalTpsl"
        : params.positionTpsl === true
          ? "positionTpsl"
          : "na";
      return { action: deepFreeze({ type: "order", orders, grouping }), price: entry.price };
    },
    modify: async (params) =>
      deepFreeze({
        type: "modify",
        oid: params.oid,
        order: await buildModifiedOrder(params),
      }),
    batchModify: async (modifies) => {
      const entries = [];
      for (const item of modifies) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- meta resolves from cache after the first.
        entries.push({ oid: item.oid, order: await buildModifiedOrder(item) });
      }
      return deepFreeze({ type: "batchModify", modifies: entries });
    },
    cancel: async (cancels) => {
      const entries = [];
      for (const item of cancels) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- meta resolves from cache after the first.
        const asset = await resolve(item.coin);
        entries.push({ a: asset.asset, o: item.oid });
      }
      return deepFreeze({ type: "cancel", cancels: entries });
    },
    cancelByCloid: async (cancels) => {
      const entries = [];
      for (const item of cancels) {
        if (!isCloid(item.cloid)) {
          throw new HyperliquidError("invalid-input", "not a cloid");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- meta resolves from cache after the first.
        const asset = await resolve(item.coin);
        entries.push({ asset: asset.asset, cloid: item.cloid });
      }
      return deepFreeze({ type: "cancelByCloid", cancels: entries });
    },
    cancelBatches: (entries) => {
      const batches: HyperliquidL1Action[] = [];
      for (let i = 0; i < entries.length; i += BATCH_CAP) {
        batches.push(deepFreeze({ type: "cancel", cancels: entries.slice(i, i + BATCH_CAP) }));
      }
      return batches;
    },
    twapCancel: async (params) => {
      const asset = await resolve(params.coin);
      return deepFreeze({
        type: "twapCancel",
        a: asset.asset,
        t: params.twapId,
      });
    },
    setLeverage: async (params) => {
      const asset = await resolve(params.coin);
      if (asset.market !== "perp" || asset.maxLeverage === undefined) {
        throw new HyperliquidError("invalid-input", `${params.coin} has no leverage`);
      }
      if (
        !Number.isInteger(params.leverage) ||
        params.leverage < 1 ||
        params.leverage > asset.maxLeverage
      ) {
        throw new HyperliquidError(
          "invalid-input",
          `leverage must be an integer in 1..${asset.maxLeverage}`,
        );
      }
      return deepFreeze({
        type: "updateLeverage",
        asset: asset.asset,
        isCross: params.marginMode === "cross",
        leverage: params.leverage,
      });
    },
    adjustMargin: async (params) => {
      const asset = await resolve(params.coin);
      if (asset.market !== "perp") {
        throw new HyperliquidError("invalid-input", "isolated margin applies to perps");
      }
      // ntli is USD × 10⁶ exactly — float_to_usd_int (utils/signing.py:489); isBuy is always
      // true on the wire (exchange.py:411 update_isolated_margin).
      const amount = parseDecimal(params.amount);
      if (amount.scale > 6) {
        throw new HyperliquidError("invalid-input", "margin adjustments allow 6 decimals");
      }
      const ntli = Number(amount.units * 10n ** BigInt(6 - amount.scale));
      if (!Number.isSafeInteger(ntli) || ntli === 0) {
        throw new HyperliquidError("invalid-input", "not a valid margin adjustment");
      }
      return deepFreeze({ type: "updateIsolatedMargin", asset: asset.asset, isBuy: true, ntli });
    },
  };
}
