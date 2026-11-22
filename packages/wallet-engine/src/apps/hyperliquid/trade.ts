import { parseDecimal } from "../../decimal.ts";
import type { HyperliquidAccount } from "./account.ts";
import { deepFreeze } from "./actions.ts";
import type {
  HyperliquidActions,
  HyperliquidModifyParams,
  HyperliquidOrderParams,
} from "./actions.ts";
import type { HyperliquidGroup, HyperliquidAgentRegistry } from "./agents.ts";
import { HyperliquidError } from "./errors.ts";
import type {
  HyperliquidActionOutcome,
  HyperliquidCancelOutcome,
  HyperliquidExchange,
  HyperliquidOrderOutcome,
  HyperliquidOutcomeCorrection,
} from "./exchange.ts";

/** `place`/`close` results: the order outcomes plus the entry cap to show the user. */
export type HyperliquidPlaceResult = {
  readonly outcomes: ReadonlyArray<HyperliquidOrderOutcome>;
  /** The entry order's wire price — for a market order or close, the slippage cap. */
  readonly price: string;
};

export type HyperliquidTrade = {
  /** Place one order — entry plus optional attached TP/SL children. */
  readonly place: (
    group: HyperliquidGroup,
    params: HyperliquidOrderParams,
  ) => Promise<HyperliquidPlaceResult>;
  /** Replace a resting order by oid or cloid. */
  readonly modify: (
    group: HyperliquidGroup,
    params: { readonly oid: number | string } & HyperliquidModifyParams,
  ) => Promise<HyperliquidActionOutcome>;
  /** Replace many resting orders in one signed action. */
  readonly batchModify: (
    group: HyperliquidGroup,
    modifies: ReadonlyArray<{ readonly oid: number | string } & HyperliquidModifyParams>,
  ) => Promise<ReadonlyArray<HyperliquidOrderOutcome>>;
  /** Cancel open orders by oid. */
  readonly cancel: (
    group: HyperliquidGroup,
    cancels: ReadonlyArray<{ readonly coin: string; readonly oid: number }>,
  ) => Promise<ReadonlyArray<HyperliquidCancelOutcome>>;
  /** Cancel open orders by cloid. */
  readonly cancelByCloid: (
    group: HyperliquidGroup,
    cancels: ReadonlyArray<{ readonly coin: string; readonly cloid: string }>,
  ) => Promise<ReadonlyArray<HyperliquidCancelOutcome>>;
  /** Cancel every open order of the account — one batch action per ≤64-order chunk. */
  readonly cancelAll: (group: HyperliquidGroup) => Promise<ReadonlyArray<HyperliquidCancelOutcome>>;
  /** Arm (or clear, with `undefined`) the dead-man's switch. */
  readonly scheduleCancel: (
    group: HyperliquidGroup,
    time?: number,
  ) => Promise<HyperliquidActionOutcome>;
  /** Start a TWAP; the outcome carries the `twapId` {@link twapCancel} needs. */
  readonly twap: (
    group: HyperliquidGroup,
    params: {
      readonly coin: string;
      readonly side: "buy" | "sell";
      readonly size: string;
      readonly minutes: number;
      readonly randomize: boolean;
      readonly reduceOnly?: boolean;
    },
  ) => Promise<HyperliquidActionOutcome>;
  /** Stop a running TWAP. */
  readonly twapCancel: (
    group: HyperliquidGroup,
    params: { readonly coin: string; readonly twapId: number },
  ) => Promise<HyperliquidActionOutcome>;
  /** Set cross or isolated leverage within the market's maximum. */
  readonly setLeverage: (
    group: HyperliquidGroup,
    params: {
      readonly coin: string;
      readonly leverage: number;
      readonly marginMode: "cross" | "isolated";
    },
  ) => Promise<HyperliquidActionOutcome>;
  /** Add to (positive) or remove from (negative) an isolated position's margin, in USD. */
  readonly adjustMargin: (
    group: HyperliquidGroup,
    params: { readonly coin: string; readonly amount: string },
  ) => Promise<HyperliquidActionOutcome>;
  /** Market-close the whole position of `coin` — reduce-only IOC at the slippage cap. */
  readonly close: (
    group: HyperliquidGroup,
    params: { readonly coin: string; readonly slippageBps: number },
  ) => Promise<HyperliquidPlaceResult>;
  /**
   * Corrections for orders whose outcome was `unknown`: the exchange re-asks them by cloid for ten
   * minutes after the call returned and learns others from live user-view frames. Nothing is ever
   * re-sent.
   */
  readonly corrections: {
    readonly subscribe: (
      listener: (correction: HyperliquidOutcomeCorrection) => void,
    ) => () => void;
  };
};

export function createHyperliquidTrade(options: {
  readonly actions: HyperliquidActions;
  readonly exchange: HyperliquidExchange;
  readonly account: HyperliquidAccount;
  readonly registry: HyperliquidAgentRegistry;
  /**
   * The builder the controller confirmed for this group — `order` actions carry `builder: {b, f}`
   * only while this returns one; never above the confirmed maximum.
   */
  readonly builderFor?: (
    group: HyperliquidGroup,
  ) => { readonly address: string; readonly feeRateTenthsBps: number } | undefined;
}): HyperliquidTrade {
  const place = async (
    group: HyperliquidGroup,
    params: HyperliquidOrderParams,
  ): Promise<HyperliquidPlaceResult> => {
    const built = await options.actions.place(params);
    const builder = options.builderFor?.(group);
    const action =
      builder === undefined
        ? built.action
        : deepFreeze({
            ...built.action,
            builder: { b: builder.address.toLowerCase(), f: builder.feeRateTenthsBps },
          });
    return {
      outcomes: await options.exchange.order(group, action),
      price: built.price,
    };
  };

  return {
    place,
    modify: async (group, params) =>
      options.exchange.action(group, await options.actions.modify(params)),
    batchModify: async (group, modifies) =>
      options.exchange.order(group, await options.actions.batchModify(modifies)),
    cancel: async (group, cancels) =>
      options.exchange.cancel(group, await options.actions.cancel(cancels)),
    cancelByCloid: async (group, cancels) =>
      options.exchange.cancel(group, await options.actions.cancelByCloid(cancels)),
    cancelAll: async (group) => {
      const { owner } = options.registry.require(group);
      const open = await options.account.openOrders({ user: owner });
      const entries = [];
      for (const order of open) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- meta resolves from cache after the first.
        const asset = await options.actions.resolve(order.coin);
        entries.push({ a: asset.asset, o: order.oid });
      }
      const outcomes: HyperliquidCancelOutcome[] = [];
      for (const batch of options.actions.cancelBatches(entries)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential posts keep nonce order simple.
        outcomes.push(...(await options.exchange.cancel(group, batch)));
      }
      return outcomes;
    },
    scheduleCancel: async (group, time) =>
      options.exchange.action(group, options.actions.scheduleCancel(time)),
    twap: async (group, params) =>
      options.exchange.action(group, await options.actions.twap(params)),
    twapCancel: async (group, params) =>
      options.exchange.action(group, await options.actions.twapCancel(params)),
    setLeverage: async (group, params) =>
      options.exchange.action(group, await options.actions.setLeverage(params)),
    adjustMargin: async (group, params) =>
      options.exchange.action(group, await options.actions.adjustMargin(params)),
    close: async (group, params) => {
      const { owner } = options.registry.require(group);
      const state = await options.account.state({ user: owner });
      const position = state.assetPositions.find((entry) => entry.position.coin === params.coin);
      const szi = position === undefined ? undefined : position.position.szi;
      if (szi === undefined || parseDecimal(szi).units === 0n) {
        throw new HyperliquidError("invalid-input", `no open position in ${params.coin}`);
      }
      return place(group, {
        coin: params.coin,
        side: szi.startsWith("-") ? "buy" : "sell",
        size: szi.replace(/^-/, ""),
        reduceOnly: true,
        order: { kind: "market", slippageBps: params.slippageBps },
      });
    },
    corrections: options.exchange.corrections,
  };
}
