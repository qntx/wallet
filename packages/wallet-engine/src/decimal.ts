/**
 * Exact fiat arithmetic: a value is `units / 10^scale` with bigint units, so multiplying a
 * base-unit amount by a decimal price and summing values never rounds. No binary float touches
 * money here.
 */
import { formatUnits } from "viem";

export type Decimal = { readonly units: bigint; readonly scale: number };

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** The exact value of a decimal string such as a contract `fiatPrice`; throws on anything else. */
export function parseDecimal(text: string): Decimal {
  const match = DECIMAL.exec(text);
  if (match === null) {
    throw new TypeError(`not a decimal: ${text}`);
  }
  const [, sign = "", whole = "", fraction = ""] = match;
  return { units: BigInt(`${sign}${whole}${fraction}`), scale: fraction.length };
}

/** `amount` base units of a `decimals`-decimal asset at `price` per whole unit. */
export const assetValue = (amount: bigint, decimals: number, price: Decimal): Decimal => ({
  units: amount * price.units,
  scale: decimals + price.scale,
});

/** The exact sum, at the largest scale among `values`. */
export function sumDecimals(values: ReadonlyArray<Decimal>): Decimal {
  const scale = Math.max(0, ...values.map((v) => v.scale));
  let units = 0n;
  for (const value of values) {
    units += value.units * 10n ** BigInt(scale - value.scale);
  }
  return { units, scale };
}

/** The canonical decimal string: no trailing fractional zeros, no dangling point. */
export const formatDecimal = (value: Decimal): string => formatUnits(value.units, value.scale);
