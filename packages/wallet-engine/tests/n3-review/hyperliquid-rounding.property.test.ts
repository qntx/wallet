/**
 * Hyperliquid price rounding, checked against an independent oracle. A wire price is valid for
 * (market, szDecimals) iff it is a whole number, or it carries at most 5 significant figures and at
 * most `6 − szDecimals` (perp) / `8 − szDecimals` (spot, floored at 0) fractional digits. The oracle
 * below is implemented from the venue rule directly — bigint digits, no production helpers.
 *
 * What it shows: a buy limit's down-round skips the integer floor — 1000010.001 lands on 1000000
 * even though the integer 1000010 is a valid wire price strictly closer to the input (the sell
 * side's up-round does take the integer ceiling into account). Sells are tight; buys can only ever
 * be beaten by an integer, never by another valid fractional price.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { limitPrice, slippagePrice } from "../../src/apps/hyperliquid/numbers.ts";
import type { HyperliquidMarket } from "../../src/apps/hyperliquid/numbers.ts";

type Dec = { readonly units: bigint; readonly scale: number };

/** "123.4500" → {units: 1234500, scale: 4} — independent reimplementation. */
const parse = (s: string): Dec => {
  const [i = "", f = ""] = s.split(".");
  return { units: BigInt(`${i}${f}`), scale: f.length };
};

const render = (d: Dec): string => {
  if (d.scale === 0) {
    return d.units.toString();
  }
  const digits = d.units.toString().padStart(d.scale + 1, "0");
  return `${digits.slice(0, -d.scale)}.${digits.slice(-d.scale)}`;
};

const canonical = (d: Dec): Dec => {
  let { units, scale } = d;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
};

/** −1 / 0 / +1 — cross-multiplied to a common denominator. */
const compare = (a: Dec, b: Dec): number => {
  const scale = Math.max(a.scale, b.scale);
  const diff = a.units * 10n ** BigInt(scale - a.scale) - b.units * 10n ** BigInt(scale - b.scale);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};

const maxDecimals = (market: HyperliquidMarket, szDecimals: number): number =>
  Math.max((market === "perp" ? 6 : 8) - szDecimals, 0);

const sigFigs = (units: bigint): number => units.toString().replace(/0+$/, "").length;

/**
 * The venue's tick rule, independently: whole numbers always pass; anything else needs ≤ 5
 * significant figures and no more fractional digits than the market allows for the lot size.
 */
const valid = (d: Dec, market: HyperliquidMarket, szDecimals: number): boolean => {
  const c = canonical(d);
  if (c.scale === 0) {
    return true;
  }
  return sigFigs(c.units) <= 5 && c.scale <= maxDecimals(market, szDecimals);
};

/** `base` moved one unit at decimal scale `k` (negative k → powers of ten). */
const stepAt = (base: Dec, k: number, sign: 1n | -1n): Dec => {
  if (k >= base.scale) {
    const scale = k;
    return { units: base.units * 10n ** BigInt(k - base.scale) + sign, scale };
  }
  return { units: base.units + sign * 10n ** BigInt(base.scale - k), scale: base.scale };
};

/** Every scale a tighter candidate could be written at: integers up to the venue's decimal cap. */
const GRID_SCALES = (maxDec: number): ReadonlyArray<number> => {
  const out: number[] = [];
  for (let k = -9; k <= Math.max(maxDec, 0); k += 1) {
    out.push(k);
  }
  return out;
};

const marketArb = fc.constantFrom("perp" as const, "spot" as const);
const szArb = fc.integer({ min: 0, max: 8 });

/** Decimal strings over 1e-8..1e7 with up to 12 fractional digits. */
const generalArb: fc.Arbitrary<string> = fc
  .tuple(fc.bigInt({ min: 1n, max: 10n ** 19n }), fc.integer({ min: 0, max: 12 }))
  .map(([units, scale]): Dec => ({ units, scale }))
  .filter(
    (d) =>
      compare(d, { units: 1n, scale: 8 }) >= 0 && compare(d, { units: 10n ** 7n, scale: 0 }) <= 0,
  )
  .map(render);

/** Non-integers ≥ 1e6 — the range where a valid integer always beats the sig-fig floor. */
const gapArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1_000_000, max: 9_999_999 }), fc.integer({ min: 1, max: 999 }))
  .map(([i, f]) => `${i}.${String(f).padStart(3, "0")}`);

const priceArb = fc.oneof(generalArb, gapArb);

describe("Hyperliquid price rounding", () => {
  it("a buy limit ignores the integer floor — the tighter valid integer is skipped", () => {
    // The shrunk property counterexample: 1000010 is integer-valid and ≤ the input, yet the
    // rounded buy lands three sig-fig grid steps below it.
    expect(limitPrice("1000010.001", "buy", 0, "perp")).toBe("1000000");
    const tighter = parse("1000010");
    expect(valid(tighter, "perp", 0)).toBe(true);
    expect(compare(tighter, parse("1000010.001"))).toBeLessThanOrEqual(0);
    expect(compare(tighter, parse("1000000"))).toBeGreaterThan(0);
    // The sell side does take the integer bound: 1000011 is the tightest valid ≥ the input.
    expect(limitPrice("1000010.001", "sell", 0, "perp")).toBe("1000011");
  });

  it("limitPrice lands valid, on the user's side — only an integer can ever beat a buy result", () => {
    let integerGapSeen = 0;
    fc.assert(
      fc.property(priceArb, marketArb, szArb, (price, market, szDecimals) => {
        const input = parse(price);
        const dec = maxDecimals(market, szDecimals);
        for (const side of ["buy", "sell"] as const) {
          let result: string;
          try {
            result = limitPrice(price, side, szDecimals, market);
          } catch {
            return; // "rounds to 0" — a refusal, not a rounding
          }
          const out = parse(result);
          expect(valid(out, market, szDecimals)).toBe(true);
          for (const k of GRID_SCALES(dec)) {
            const step = side === "buy" ? 1n : -1n;
            const tighter = stepAt(out, k, step);
            const between =
              side === "buy"
                ? compare(out, tighter) < 0 && compare(tighter, input) <= 0
                : compare(tighter, out) < 0 && compare(tighter, input) >= 0;
            const fits = tighter.units > 0n && valid(tighter, market, szDecimals) && between;
            if (!fits) {
              continue;
            }
            // A tighter valid price exists between out and the input. For sells that is a direct
            // violation; for buys the only slack the rounding leaves is a whole number.
            expect(side === "buy" && canonical(tighter).scale === 0).toBe(true);
            integerGapSeen += 1;
          }
          if (side === "buy") {
            expect(compare(out, input)).toBeLessThanOrEqual(0);
          } else {
            expect(compare(out, input)).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      { numRuns: 200 },
    );
    // The integer-floor gap is not theoretical — generated inputs exercised it.
    expect(integerGapSeen).toBeGreaterThan(0);
  });

  it("slippagePrice stays inside the exact basis-point bound", () => {
    fc.assert(
      fc.property(
        priceArb,
        marketArb,
        szArb,
        fc.integer({ min: 1, max: 9999 }),
        (reference, market, szDecimals, bps) => {
          const ref = parse(reference);
          for (const side of ["buy", "sell"] as const) {
            const factor = BigInt(side === "buy" ? 10_000 + bps : 10_000 - bps);
            const bound: Dec = { units: ref.units * factor, scale: ref.scale + 4 };
            let result: string;
            try {
              result = slippagePrice(reference, side, bps, szDecimals, market);
            } catch {
              return; // out-of-range bps or rounds to 0 — a refusal
            }
            const out = parse(result);
            expect(valid(out, market, szDecimals)).toBe(true);
            if (side === "buy") {
              expect(compare(out, bound)).toBeLessThanOrEqual(0);
            } else {
              expect(compare(out, bound)).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
