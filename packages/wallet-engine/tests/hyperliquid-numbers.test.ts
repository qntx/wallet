/**
 * Tick/lot rounding against the independent oracle: for the "down" direction the result must equal
 * the SDK's formatPrice/formatSize byte for byte (or both must throw); for "up" the result must be
 * the smallest valid price ≥ the input — validity, minimality (enumerated over the candidate grid),
 * idempotence and the kernel's canonical decimal form.
 */
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";
import {
  limitPrice,
  meetsMinimum,
  notional,
  roundPrice,
  roundSize,
  slippagePrice,
} from "../src/apps/hyperliquid/numbers.ts";
import type { HyperliquidMarket, RoundDirection } from "../src/apps/hyperliquid/numbers.ts";

const numRuns = Number(process.env["FUZZ_RUNS"] ?? "200");

/** Positive decimal strings: units/10^scale — deliberately not canonical (trailing zeros, etc). */
const decimal = fc
  .tuple(fc.bigInt({ min: 1n, max: 10n ** 16n }), fc.integer({ min: 0, max: 18 }))
  .map(([units, scale]) => {
    const digits = units.toString().padStart(scale + 1, "0");
    return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  });
const szDecimals = fc.integer({ min: 0, max: 10 });
const market = fc.constantFrom("perp", "spot") as fc.Arbitrary<HyperliquidMarket>;

const CANONICAL = /^(0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

const maxDecimals = (m: HyperliquidMarket, sz: number): number =>
  Math.max((m === "perp" ? 6 : 8) - sz, 0);

/** Independent re-check of the docs' validity rules; accepts non-canonical spellings like the SDK. */
const isValidPrice = (s: string, sz: number, m: HyperliquidMarket): boolean => {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(s);
  if (match === null) {
    return false;
  }
  const [, whole, rawFraction = ""] = match;
  const fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length > maxDecimals(m, sz)) {
    return false;
  }
  if (fraction.length === 0) {
    return true; // integer
  }
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  return digits.length > 0 && digits.length <= 5;
};

const parse = (s: string): { units: bigint; scale: number } => {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(s);
  if (match === null) {
    throw new Error(`not a decimal: ${s}`);
  }
  return { units: BigInt(`${match[1]}${match[2] ?? ""}`), scale: (match[2] ?? "").length };
};
const compare = (a: string, b: string): number => {
  const pa = parse(a);
  const pb = parse(b);
  const shift = Math.min(pa.scale, pb.scale, 0);
  const A = pa.units * 10n ** BigInt(pb.scale - shift);
  const B = pb.units * 10n ** BigInt(pa.scale - shift);
  return A < B ? -1 : A > B ? 1 : 0;
};

const leadingPosition = (s: string): number => {
  const { units, scale } = parse(s);
  return String(units).length - scale - 1;
};

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** `ceil(units / 10^(scale + e))` — the value scaled to a `m·10^e` grid. */
const scaledCeil = (units: bigint, scale: number, e: number): bigint => {
  const shift = scale + e;
  return shift >= 0 ? ceilDiv(units, 10n ** BigInt(shift)) : units * 10n ** BigInt(-shift);
};

/** The decimal string for `m·10^e` (trailing zeros possible — validity canonicalizes). */
const gridText = (m: bigint, e: number): string => {
  if (e >= 0) {
    return `${m}${"0".repeat(e)}`;
  }
  const digits = m.toString().padStart(-e + 1, "0");
  return `${digits.slice(0, e)}.${digits.slice(e)}`;
};

/**
 * No valid price may lie in `[input, result)`: enumerate the feasible candidates — integers, then
 * `m·10^e` with `m ≤ 99999` for every grid level `e` from `-maxDecimals` up to just above the
 * result — and assert each is either invalid or below the input.
 */
const assertMinimal = (
  input: string,
  result: string,
  sz: number,
  mkt: HyperliquidMarket,
): ReadonlyArray<string> => {
  const xi = parse(input);
  const ri = parse(result);
  const candidates: string[] = [];
  // Integers in [input, result).
  const loInt = scaledCeil(xi.units, xi.scale, 0);
  const hiInt = scaledCeil(ri.units, ri.scale, 0) - 1n;
  for (let i = loInt < 1n ? 1n : loInt; i <= hiInt; i += 1n) {
    candidates.push(i.toString());
  }
  // m·10^e on every feasible grid level.
  for (let e = -maxDecimals(mkt, sz); e <= leadingPosition(result) + 1; e += 1) {
    if (e === 0) {
      continue; // the integer loop above covers e = 0
    }
    const lo = scaledCeil(xi.units, xi.scale, e);
    const hi = scaledCeil(ri.units, ri.scale, e) - 1n;
    for (let m = lo < 1n ? 1n : lo; m <= hi && m <= 99_999n; m += 1n) {
      candidates.push(gridText(m, e));
    }
  }
  return candidates.filter(
    (c) => isValidPrice(c, sz, mkt) && !(compare(c, input) < 0 || compare(c, result) >= 0),
  );
};

const ROUND = { down: "down", up: "up" } as const;

/** An outcome shape test callbacks can compare with one strict-equal — no branches inside `it`. */
type Outcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly category: string };

const ourPrice = (px: string, sz: number, mkt: HyperliquidMarket, dir: RoundDirection): Outcome => {
  try {
    return { ok: true, value: roundPrice(px, sz, mkt, dir) };
  } catch (error) {
    return {
      ok: false,
      category: error instanceof HyperliquidError ? error.category : `foreign: ${String(error)}`,
    };
  }
};

const ourSize = (size: string, sz: number): Outcome => {
  try {
    return { ok: true, value: roundSize(size, sz) };
  } catch (error) {
    return {
      ok: false,
      category: error instanceof HyperliquidError ? error.category : `foreign: ${String(error)}`,
    };
  }
};

const sdkPrice = (px: string, sz: number, mkt: HyperliquidMarket): Outcome => {
  try {
    return { ok: true, value: formatPrice(px, sz, mkt) };
  } catch {
    return { ok: false, category: "invalid-input" };
  }
};

const sdkSize = (size: string, sz: number): Outcome => {
  try {
    return { ok: true, value: formatSize(size, sz) };
  } catch {
    return { ok: false, category: "invalid-input" };
  }
};

/** Rounding an already-rounded value is a no-op — the error case round-trips itself. */
const roundTwice = (
  px: string,
  sz: number,
  mkt: HyperliquidMarket,
  dir: RoundDirection,
): Outcome => {
  const once = ourPrice(px, sz, mkt, dir);
  return once.ok ? ourPrice(once.value, sz, mkt, dir) : once;
};

/** `pred(result)` on success, `true` only when the failure is the expected invalid-input. */
const meets = (outcome: Outcome, pred: (value: string) => boolean): boolean =>
  outcome.ok ? pred(outcome.value) : outcome.category === "invalid-input";

describe("hyperliquid number rules", () => {
  it("round down equals the SDK formatPrice oracle (or both throw)", { timeout: 20_000 }, () => {
    fc.assert(
      fc.property(decimal, szDecimals, market, (px, sz, mkt) => {
        expect(ourPrice(px, sz, mkt, ROUND.down)).toStrictEqual(sdkPrice(px, sz, mkt));
      }),
      { numRuns },
    );
  });

  it("roundSize equals the SDK formatSize oracle (or both throw)", { timeout: 20_000 }, () => {
    fc.assert(
      fc.property(decimal, szDecimals, (size, sz) => {
        expect(ourSize(size, sz)).toStrictEqual(sdkSize(size, sz));
      }),
      { numRuns },
    );
  });

  it(
    "round up is the minimal valid price ≥ input, canonical and idempotent",
    { timeout: 30_000 },
    () => {
      fc.assert(
        fc.property(decimal, szDecimals, market, (px, sz, mkt) => {
          const result = roundPrice(px, sz, mkt, ROUND.up);
          expect(result).toMatch(CANONICAL);
          expect(isValidPrice(result, sz, mkt)).toBe(true);
          expect(compare(result, px)).toBeGreaterThanOrEqual(0);
          expect(roundPrice(result, sz, mkt, ROUND.up)).toBe(result);
          expect(assertMinimal(px, result, sz, mkt)).toStrictEqual([]);
        }),
        { numRuns },
      );
    },
  );

  it("round down is idempotent and ≤ input", { timeout: 20_000 }, () => {
    fc.assert(
      fc.property(decimal, szDecimals, market, (px, sz, mkt) => {
        const once = ourPrice(px, sz, mkt, ROUND.down);
        expect(roundTwice(px, sz, mkt, ROUND.down)).toStrictEqual(once);
        expect(meets(once, (value) => compare(value, px) <= 0)).toBe(true);
      }),
      { numRuns },
    );
  });

  it("limitPrice rounds buys down and sells up", () => {
    expect(limitPrice("1.234567", "buy", 0, "perp")).toBe("1.2345");
    expect(limitPrice("1.234567", "sell", 0, "perp")).toBe("1.2346");
    expect(limitPrice("100", "buy", 0, "perp")).toBe("100");
  });

  it("slippagePrice moves the reference and rounds by side", () => {
    expect(slippagePrice("100", "buy", 50, 0, "perp")).toBe("100.5");
    expect(slippagePrice("100", "sell", 50, 0, "perp")).toBe("99.5");
    expect(slippagePrice("100", "buy", 10_000, 0, "perp")).toBe("200");
    expect(slippagePrice("100", "sell", 9999, 0, "perp")).toBe("0.01");
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => slippagePrice("100", "buy", bad, 0, "perp")).toThrow(HyperliquidError);
    }
    expect(() => slippagePrice("100", "buy", 10_001, 0, "perp")).toThrow(HyperliquidError);
    expect(() => slippagePrice("100", "sell", 10_000, 0, "perp")).toThrow(HyperliquidError);
  });

  it("notional is exact and meetsMinimum enforces the 10-quote bound", () => {
    expect(notional("97123.45", "0.001")).toBe("97.12345");
    expect(notional("0.1", "0.1")).toBe("0.01");
    expect(meetsMinimum("97123.45", "0.001")).toBe(true);
    expect(meetsMinimum("9", "1.1")).toBe(false);
    expect(meetsMinimum("10", "1")).toBe(true);
    expect(meetsMinimum("10", "0.9999999")).toBe(false);
  });
});
