/**
 * Fiat valuation of holdings, exact: values are bigint fixed-point (see `decimal.ts`), the total is
 * their exact sum. Display-only — nothing that builds, approves or signs may read it.
 */
import type { FiatCurrency } from "../gateway/contract/index.ts";
import type { PricesState } from "./controller.ts";
import { assetValue, formatDecimal, parseDecimal, sumDecimals } from "./decimal.ts";
import type { Decimal } from "./decimal.ts";
import type { Holding } from "./holdings.ts";

/** A quote older than this (by the provider's own `updatedAt`) is shown as stale. */
export const PRICE_STALE_MS = 10 * 60_000;

export type PriceView = {
  readonly price: string;
  // oxlint-disable-next-line typescript/no-restricted-types -- wire shape: null when the provider has no 24 h change
  readonly change24h: string | null;
  readonly updatedAt: number;
  readonly stale: boolean;
};

export type ValuedHolding = Holding & {
  /** Absent when the asset has no quote: a network without prices, unpriced, or not fetched yet. */
  readonly price?: PriceView;
  /** `amount` at `price`, a decimal string in the state's currency. */
  readonly value?: string;
};

export type Valuation = {
  readonly currency: FiatCurrency;
  /** The exact sum of every priced holding's value. */
  readonly total: string;
  /** Whether a stale quote contributed to the total. */
  readonly stale: boolean;
  /** How many holdings have no price and are left out of the total. */
  readonly unpriced: number;
  readonly holdings: ReadonlyArray<ValuedHolding>;
};

/** Values `holdings` at the quotes in `prices`, as of `now`. */
export function valueHoldings(
  holdings: ReadonlyArray<Holding>,
  prices: Pick<PricesState, "currency" | "quotes">,
  now: number,
): Valuation {
  const values: Decimal[] = [];
  let stale = false;
  const valued = holdings.map((holding): ValuedHolding => {
    const quote = holding.asset === undefined ? undefined : prices.quotes[holding.asset];
    if (quote === undefined) {
      return holding;
    }
    const value = assetValue(holding.amount, holding.decimals, parseDecimal(quote.price));
    const view = { ...quote, stale: now - quote.updatedAt > PRICE_STALE_MS };
    values.push(value);
    stale ||= view.stale;
    return { ...holding, price: view, value: formatDecimal(value) };
  });
  return {
    currency: prices.currency,
    total: formatDecimal(sumDecimals(values)),
    stale,
    unpriced: valued.filter((h) => h.price === undefined).length,
    holdings: valued,
  };
}
