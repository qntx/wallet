import { createHyperliquidAccount } from "./account.ts";
import type { HyperliquidAccount } from "./account.ts";
import { createHyperliquidClock } from "./clock.ts";
import type { HyperliquidClock } from "./clock.ts";
import { createHyperliquidMarkets } from "./markets.ts";
import type { HyperliquidMarkets } from "./markets.ts";
import { limitPrice, meetsMinimum, notional, roundSize, slippagePrice } from "./numbers.ts";
import type { HyperliquidMarket, OrderSide } from "./numbers.ts";
import { createHyperliquidTransport } from "./transport.ts";
import type { HyperliquidTransportOptions } from "./transport.ts";

/** What a quote preview shows the interface: the wire-ready order and its value checks. */
export type HyperliquidQuotePreview = {
  /** The rounded price that would go on the wire (for a market order, the slippage cap). */
  readonly price: string;
  /** The rounded size that would go on the wire. */
  readonly size: string;
  /** `price` × `size` exactly. */
  readonly notional: string;
  /** Whether the order clears Hyperliquid's 10-quote minimum. */
  readonly meetsMinimum: boolean;
};

/** Pure order preview helpers — no I/O, safe to call on every render. */
export type HyperliquidQuote = {
  /** Preview a limit order: price rounded the user's way (buy down, sell up). */
  readonly limit: (params: {
    readonly price: string;
    readonly size: string;
    readonly side: OrderSide;
    readonly szDecimals: number;
    readonly market: HyperliquidMarket;
  }) => HyperliquidQuotePreview;
  /** Preview a market order: the IOC cap at `slippageBps` from `reference`. */
  readonly market: (params: {
    readonly reference: string;
    readonly size: string;
    readonly side: OrderSide;
    readonly slippageBps: number;
    readonly szDecimals: number;
    readonly market: HyperliquidMarket;
  }) => HyperliquidQuotePreview;
};

export type HyperliquidProvider = {
  readonly markets: HyperliquidMarkets;
  readonly account: HyperliquidAccount;
  readonly quote: HyperliquidQuote;
  /** The skew/nonce clock the transport feeds — exposed so callers can gate signing on it. */
  readonly clock: HyperliquidClock;
};

export type HyperliquidProviderOptions = Pick<
  HyperliquidTransportOptions,
  "network" | "fetch" | "setTimer" | "now" | "timeoutMs"
>;

const preview = (price: string, size: string, szDecimals: number): HyperliquidQuotePreview => {
  const roundedSize = roundSize(size, szDecimals);
  return {
    price,
    size: roundedSize,
    notional: notional(price, roundedSize),
    meetsMinimum: meetsMinimum(price, roundedSize),
  };
};

export function createHyperliquidProvider(
  options: HyperliquidProviderOptions,
): HyperliquidProvider {
  const clock = createHyperliquidClock(options.now);
  const transport = createHyperliquidTransport({ ...options, clock });
  const config = { transport };
  return {
    markets: createHyperliquidMarkets(config),
    account: createHyperliquidAccount(config),
    quote: {
      limit: ({ price, size, side, szDecimals, market }) =>
        preview(limitPrice(price, side, szDecimals, market), size, szDecimals),
      market: ({ reference, size, side, slippageBps, szDecimals, market }) =>
        preview(slippagePrice(reference, side, slippageBps, szDecimals, market), size, szDecimals),
    },
    clock,
  };
}
