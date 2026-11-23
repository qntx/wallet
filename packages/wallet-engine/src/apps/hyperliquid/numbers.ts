import { formatDecimal, parseDecimal } from "../spi.ts";
import type { Decimal } from "../spi.ts";
import { HyperliquidError } from "./errors.ts";

/**
 * Exact decimal arithmetic for Hyperliquid tick and lot rules — bigint units only, no float ever
 * touches a price or size. Prices admit at most 5 significant figures unless they are integers, and
 * at most 6 (perp) or 8 (spot) − `szDecimals` fractional decimals; sizes admit at most `szDecimals`
 * decimals. Rounded output is always the kernel's canonical decimal form.
 */
export type HyperliquidMarket = "perp" | "spot";
export type OrderSide = "buy" | "sell";
export type RoundDirection = "down" | "up";

const DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;
const MAX_SIG_FIGS = 4; // grid exponent = leading position − (5 − 1)

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

const parsePositive = (text: string, field: string): Decimal => {
  if (!DECIMAL.test(text)) {
    throw new HyperliquidError("invalid-input", `${field} is not a decimal: ${text}`);
  }
  const value = parseDecimal(text);
  if (value.units <= 0n) {
    throw new HyperliquidError("invalid-input", `${field} must be positive: ${text}`);
  }
  return value;
};

const isInteger = (value: Decimal): boolean =>
  value.scale <= 0 || value.units % pow10(value.scale) === 0n;

/** `formatDecimal` needs a non-negative scale — fold a negative one into the units. */
const canonical = (value: Decimal): Decimal =>
  value.scale < 0 ? { units: value.units * pow10(-value.scale), scale: 0 } : value;

const format = (value: Decimal): string => formatDecimal(canonical(value));

/** The exponent of the value's most significant decimal digit. */
const leadingPosition = (value: Decimal): number => String(value.units).length - value.scale - 1;

const lessThan = (a: Decimal, b: Decimal): boolean => {
  // Cross-multiply to a common denominator, shifted so neither exponent goes negative.
  const shift = Math.min(a.scale, b.scale, 0);
  return a.units * pow10(b.scale - shift) < b.units * pow10(a.scale - shift);
};

/** Round to `scale` fractional decimals — a negative `scale` rounds to powers of ten. */
const roundToScale = (value: Decimal, scale: number, direction: RoundDirection): Decimal => {
  const drop = value.scale - scale;
  if (drop <= 0) {
    return value;
  }
  const quantum = pow10(drop);
  const units =
    direction === "down" ? value.units / quantum : (value.units + quantum - 1n) / quantum;
  return { units, scale };
};

const maxDecimals = (market: HyperliquidMarket, szDecimals: number): number =>
  Math.max((market === "perp" ? 6 : 8) - szDecimals, 0);

const checkSzDecimals = (szDecimals: number): void => {
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new HyperliquidError("invalid-input", `szDecimals ${szDecimals} is not an integer ≥ 0`);
  }
};

/**
 * "down" mirrors the SDK's `formatPrice` — decimal places first, then significant figures — so
 * property tests can use it as the oracle. "up" returns the smallest valid price ≥ the input: the
 * minimum of the 5-significant-figure ceiling and the always-valid integer ceiling.
 */
const round = (
  value: Decimal,
  szDecimals: number,
  market: HyperliquidMarket,
  direction: RoundDirection,
): Decimal => {
  const limit = maxDecimals(market, szDecimals);
  if (direction === "down") {
    const decimals = roundToScale(value, limit, "down");
    if (decimals.units === 0n) {
      throw new HyperliquidError("invalid-input", "price rounds to 0");
    }
    if (isInteger(decimals)) {
      return decimals;
    }
    return roundToScale(decimals, MAX_SIG_FIGS - leadingPosition(decimals), "down");
  }
  const integer = roundToScale(value, 0, "up");
  const grid = Math.min(MAX_SIG_FIGS - leadingPosition(value), limit);
  const significant = roundToScale(value, grid, "up");
  return lessThan(integer, significant) ? integer : significant;
};

/** `price` rounded to the tick rules for `market` in `direction`; 0 is an error. */
export const roundPrice = (
  price: string,
  szDecimals: number,
  market: HyperliquidMarket,
  direction: RoundDirection,
): string => {
  checkSzDecimals(szDecimals);
  return format(round(parsePositive(price, "price"), szDecimals, market, direction));
};

/** `size` rounded down to `szDecimals` decimals — the lot size; 0 is an error. */
export const roundSize = (size: string, szDecimals: number): string => {
  checkSzDecimals(szDecimals);
  const value = parsePositive(size, "size");
  const result = roundToScale(value, szDecimals, "down");
  if (result.units === 0n) {
    throw new HyperliquidError("invalid-input", "size rounds to 0");
  }
  return format(result);
};

/** A limit price never worse than the user's: buys round down, sells round up. */
export const limitPrice = (
  price: string,
  side: OrderSide,
  szDecimals: number,
  market: HyperliquidMarket,
): string => roundPrice(price, szDecimals, market, side === "buy" ? "down" : "up");

/**
 * The slippage-bounded price for a marketable (IOC) order: `reference` moved `slippageBps` basis
 * points against the order — buy: ×(1 + bps/10⁴), sell: ×(1 − bps/10⁴) — then rounded the way
 * {@link limitPrice} rounds. `slippageBps` is an integer: 1..10000 for a buy, 1..9999 for a sell (0
 * or 100% is no market order).
 */
export const slippagePrice = (
  reference: string,
  side: OrderSide,
  slippageBps: number,
  szDecimals: number,
  market: HyperliquidMarket,
): string => {
  checkSzDecimals(szDecimals);
  const bound = side === "buy" ? 10_000 : 9999;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > bound) {
    throw new HyperliquidError(
      "invalid-input",
      `slippageBps ${slippageBps} out of range for a ${side}`,
    );
  }
  const value = parsePositive(reference, "reference");
  const factor = BigInt(side === "buy" ? 10_000 + slippageBps : 10_000 - slippageBps);
  const scaled: Decimal = { units: value.units * factor, scale: value.scale + 4 };
  return format(round(scaled, szDecimals, market, side === "buy" ? "down" : "up"));
};

/** `price` × `size` exactly, as a canonical decimal string. */
export const notional = (price: string, size: string): string => {
  const px = parsePositive(price, "price");
  const sz = parsePositive(size, "size");
  return format({ units: px.units * sz.units, scale: px.scale + sz.scale });
};

/** Hyperliquid's minimum order value: notional ≥ 10 quote units (USDC perps, quote token spot). */
export const meetsMinimum = (price: string, size: string): boolean => {
  const px = parsePositive(price, "price");
  const sz = parsePositive(size, "size");
  return px.units * sz.units >= pow10(px.scale + sz.scale + 1);
};
