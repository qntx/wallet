/**
 * Canonical-decimal ↔ fixed-point codec shared by every metered session scheme: a scheme's meter
 * charges in units of `DECIMAL_SCALE` and the record header stores the canonical decimal string
 * (`SESSION_SPENT`). Arithmetic is exact on bigints — no float is ever involved. 1e-16 admits the
 * sixteen fractional digits an 8-decimal price times an 8-decimal size produces exactly; a meter
 * whose grammar admits finer decimals picks a coarser scale and rounds a charge up, never down.
 */
import { KernelError } from "./errors.ts";

export const DECIMAL_SCALE: bigint = 10n ** 16n;

/** A canonical decimal to units of `DECIMAL_SCALE` — throws `integrity` past its precision. */
export const decimalToUnits = (decimal: string): bigint => {
  const dot = decimal.indexOf(".");
  const whole = dot === -1 ? decimal : decimal.slice(0, dot);
  const frac = dot === -1 ? "" : decimal.slice(dot + 1);
  if (frac.length > 16) {
    throw new KernelError("integrity", "over-precise decimal");
  }
  return BigInt(whole) * DECIMAL_SCALE + BigInt(frac.padEnd(16, "0") || "0");
};

/** Units of `DECIMAL_SCALE` back to the canonical decimal string the header stores. */
export const unitsToDecimal = (units: bigint): string => {
  const whole = units / DECIMAL_SCALE;
  const frac = (units % DECIMAL_SCALE).toString().padStart(16, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
};
