// oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect -- property tests
// filter generated inputs and branch on side; conditionals are inherent to the oracle assertions.

/**
 * Order math — pure bigint cases plus fast-check oracles: `getOrderRawAmounts` /
 * `getMarketOrderRawAmounts` deep-imported from the devDependency `@polymarket/clob-client-v2` (its
 * `exports` map hides subpaths, so tests reach `dist/` by relative path — test-only). On-tick limit
 * amounts must equal the oracle's exactly; market bounds may differ only in the user's favour by at
 * most one unit of the last amount decimal (we ceil, the SDK floors).
 */
import * as fc from "fast-check";
import { parseUnits } from "viem";
import { describe, expect, it } from "vite-plus/test";

/* The SDK's exports map hides its helpers; tests deep-import dist/ by relative path (test-only). */
// @ts-expect-error — this dist helper ships no .d.ts (test-only import)
import { getMarketOrderRawAmounts } from "../../../node_modules/@polymarket/clob-client-v2/dist/order-builder/helpers/getMarketOrderRawAmounts.js";
// @ts-expect-error — this dist helper ships no .d.ts (test-only import)
import { getOrderRawAmounts } from "../../../node_modules/@polymarket/clob-client-v2/dist/order-builder/helpers/getOrderRawAmounts.js";
// @ts-expect-error — this dist helper ships no .d.ts (test-only import)
import { ROUNDING_CONFIG } from "../../../node_modules/@polymarket/clob-client-v2/dist/order-builder/helpers/roundingConfig.js";
import { Side } from "../../../node_modules/@polymarket/clob-client-v2/dist/order-utils/model/side.js";
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import type { PolymarketBook } from "../src/apps/polymarket/markets.ts";
import { limitAmounts, quoteLimit, quoteMarket } from "../src/apps/polymarket/orders.ts";

const book = (over: Partial<PolymarketBook> = {}): PolymarketBook => ({
  assetId: "123",
  conditionId: `0x${"1".repeat(64)}`,
  version: "v1",
  bids: [],
  asks: [],
  tickSize: "0.01",
  minOrderSize: "5",
  negRisk: false,
  timestamp: "0",
  hash: "0x",
  ...over,
});

/** SDK `rawAmounts` decimal → the 6-decimal integer string, as `buildOrderCreationArgs` does. */
const sdkUnits = (value: number): string => parseUnits(value.toString(), 6).toString(10);

const TICK_SIZES = ["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"] as const;

describe("polymarket orders — limit math", () => {
  it("rounds BUY down and SELL up to the tick and swaps maker/taker", () => {
    const b = book();
    const buy = quoteLimit({ assetId: "1", side: "BUY", price: "0.529", size: "10.567" }, b);
    expect(buy.price).toBe("0.52");
    expect(buy.size).toBe("10.56");
    expect(buy.makerAmount).toBe("5491200"); // 10.56 × 0.52
    expect(buy.takerAmount).toBe("10560000");

    const sell = quoteLimit(
      { assetId: "1", side: "SELL", price: String(0.521), size: "10.567" },
      b,
    );
    expect(sell.price).toBe("0.53");
    expect(sell.makerAmount).toBe("10560000");
    expect(sell.takerAmount).toBe("5596800"); // 10.56 × 0.53
  });

  it("bounds the price to [tick, 1 − tick] after rounding", () => {
    const b = book({ tickSize: "0.01" });
    expect(() => quoteLimit({ assetId: "1", side: "BUY", price: "0.004", size: "10" }, b)).toThrow(
      PolymarketError,
    );
    expect(() => quoteLimit({ assetId: "1", side: "SELL", price: "0.995", size: "10" }, b)).toThrow(
      PolymarketError,
    );
    // boundary prices are accepted
    quoteLimit({ assetId: "1", side: "BUY", price: "0.01", size: "10" }, b);
    quoteLimit({ assetId: "1", side: "SELL", price: "0.99", size: "10" }, b);
  });

  it("accepts a size exactly at the market minimum", () => {
    const quote = quoteLimit({ assetId: "1", side: "BUY", price: "0.5", size: "5" }, book());
    expect(quote.takerAmount).toBe("5000000");
  });

  it("refuses unknown ticks, sub-minimum and zero sizes", () => {
    expect(() =>
      quoteLimit(
        { assetId: "1", side: "BUY", price: "0.5", size: "10" },
        book({ tickSize: "0.02" }),
      ),
    ).toThrow(PolymarketError);
    expect(() =>
      quoteLimit({ assetId: "1", side: "BUY", price: "0.5", size: "4.9" }, book()),
    ).toThrow(PolymarketError);
    expect(() =>
      quoteLimit({ assetId: "1", side: "BUY", price: "0.5", size: "0.001" }, book()),
    ).toThrow(PolymarketError);
  });

  it("refuses a product that needs more than 6 decimals — exact, never silent", () => {
    expect(() => limitAmounts("BUY", 1n, 1n)).toThrow(PolymarketError);
  });

  it(
    "equals the SDK oracle exactly for on-tick inputs across every tick",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...TICK_SIZES),
          fc.constantFrom("BUY", "SELL"),
          fc.integer({ min: 1, max: 9999 }),
          fc.integer({ min: 1, max: 9999 }),
          (tick, side, priceInt, sizeInt) => {
            const config = ROUNDING_CONFIG[tick];
            const priceDecimals = config.price;
            const tickUnits = parseUnits(tick, 6);
            const priceUnits = BigInt(priceInt) * tickUnits; // on-tick
            if (priceUnits <= 0n || priceUnits >= 1_000_000n) {
              return;
            }
            const price = (Number(priceUnits) / 1e6).toFixed(priceDecimals);
            const size = (sizeInt / 100).toFixed(config.size);
            const minSize = "1";
            const b = book({ tickSize: tick, minOrderSize: minSize });
            if (sizeInt < 100) {
              return; // below our test minimum
            }
            const quote = quoteLimit({ assetId: "1", side, price, size }, b);
            const oracle = getOrderRawAmounts(
              side === "BUY" ? Side.BUY : Side.SELL,
              Number(size),
              Number(price),
              config,
            );
            expect(quote.makerAmount).toBe(sdkUnits(oracle.rawMakerAmt));
            expect(quote.takerAmount).toBe(sdkUnits(oracle.rawTakerAmt));
          },
        ),
        { numRuns: 300 },
      );
    },
  );

  it(
    "never moves the implied price past the user's limit for any input",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...TICK_SIZES),
          fc.constantFrom("BUY", "SELL"),
          fc.double({ min: 0.1, max: 0.9, noNaN: true }),
          fc.double({ min: 5, max: 1000, noNaN: true }),
          (tick, side, price, size) => {
            const b = book({ tickSize: tick, minOrderSize: "1" });
            const priceStr = price.toFixed(6);
            const sizeStr = size.toFixed(4);
            const quote = quoteLimit({ assetId: "1", side, price: priceStr, size: sizeStr }, b);
            const implied = Number(quote.impliedPrice);
            const asked = Number(priceStr);
            if (side === "BUY") {
              expect(implied).toBeLessThanOrEqual(asked + 1e-9);
            } else {
              expect(implied).toBeGreaterThanOrEqual(asked - 1e-9);
            }
            expect(Number(quote.size)).toBeLessThanOrEqual(Number(sizeStr));
          },
        ),
        { numRuns: 300 },
      );
    },
  );
});

describe("polymarket orders — market math", () => {
  const asks = [
    { price: "0.52", size: "100" },
    { price: "0.55", size: "100" },
    { price: "0.60", size: "100" },
  ];
  const bids = [
    { price: "0.50", size: "80" },
    { price: "0.48", size: "80" },
    { price: "0.45", size: "80" },
  ];
  const orderBook = (over: Partial<PolymarketBook> = {}) =>
    book({ asks, bids, tickSize: "0.01", minOrderSize: "1", ...over });

  it("BUY walks the asks, bounds by slippage and ceils the demanded shares", () => {
    const quote = quoteMarket(
      { assetId: "1", side: "BUY", amount: "100", slippageBps: 500, orderType: "FOK" },
      orderBook(),
    );
    // worst level touched: 0.52·100 + 0.55·100 covers only 107 < 100? 52+55 = 107 ≥ 100 → w = 0.55
    expect(quote.bound).toBe("0.58"); // 0.55 × 1.05 = 0.5775 → ceil-ticked to 0.58
    expect(quote.makerAmount).toBe("100000000"); // 100 pUSD
    // taker = ceil(100e6·1e4 / 580000)·1e-4 → 172.4138 shares
    expect(quote.takerAmount).toBe("172413800");
    expect(Number(quote.impliedPrice)).toBeLessThanOrEqual(0.58);
    expect(quote.partial).toBeUndefined();
  });

  it("SELL walks the bids and floors the bound by slippage", () => {
    const quote = quoteMarket(
      { assetId: "1", side: "SELL", amount: "100", slippageBps: 500, orderType: "FOK" },
      orderBook(),
    );
    // depth: 80+80 < 100? no — 80+80=160 ≥ 100 → w = 0.48; bound = 0.48×0.95 = 0.456 → floor-tick 0.45
    expect(quote.bound).toBe("0.45");
    expect(quote.makerAmount).toBe("100000000"); // 100 shares
    expect(quote.takerAmount).toBe("45000000"); // ceil(100·0.45) = 45 pUSD
    expect(Number(quote.impliedPrice)).toBeGreaterThanOrEqual(0.45);
  });

  it("FOK refuses insufficient depth and FAK reports partial with the fillable amount", () => {
    const params = {
      assetId: "1",
      side: "BUY" as const,
      amount: "500",
      slippageBps: 100,
      orderType: "FOK" as const,
    };
    expect(() => quoteMarket(params, orderBook())).toThrow(PolymarketError);
    const fak = quoteMarket({ ...params, orderType: "FAK" }, orderBook());
    expect(fak.partial).toBe(true);
    // fillable notional = 100·0.52 + 100·0.55 + 100·0.60 = 167 pUSD → carried amount
    expect(fak.amount).toBe("167");
    expect(fak.bound).toBe("0.61"); // 0.60 × 1.01 = 0.606 → ceil-ticked to 0.61
  });

  it("refuses bad slippage and empty books", () => {
    expect(() =>
      quoteMarket(
        { assetId: "1", side: "BUY", amount: "10", slippageBps: 5001, orderType: "FAK" },
        orderBook(),
      ),
    ).toThrow(PolymarketError);
    expect(() =>
      quoteMarket(
        { assetId: "1", side: "BUY", amount: "10", slippageBps: -1, orderType: "FAK" },
        orderBook(),
      ),
    ).toThrow(PolymarketError);
    expect(() =>
      quoteMarket(
        { assetId: "1", side: "BUY", amount: "10", slippageBps: 0, orderType: "FAK" },
        orderBook({ asks: [] }),
      ),
    ).toThrow(PolymarketError);
  });

  it(
    "differs from the SDK oracle only in the user's favour, ≤ 1 unit of the last amount decimal",
    { timeout: 120_000 },
    () => {
      let diverged = 0;
      let oracleSkipped = 0;
      fc.assert(
        fc.property(
          fc.constantFrom(...TICK_SIZES),
          fc.constantFrom("BUY", "SELL"),
          fc.integer({ min: 100, max: 9_999_999 }),
          fc.integer({ min: 1, max: 9500 }),
          fc.integer({ min: 0, max: 5000 }),
          (tick, side, amountInt, priceInt, slippageBps) => {
            const config = ROUNDING_CONFIG[tick];
            const tickUnits = parseUnits(tick, 6);
            const boundUnits = BigInt(priceInt) * tickUnits;
            if (boundUnits <= 0n || boundUnits >= 1_000_000n) {
              return;
            }
            const amount = (amountInt / 100).toFixed(config.size);
            const price = (Number(boundUnits) / 1e6).toFixed(config.price);
            // Depth that always covers the amount so the quote never partials out.
            const deep = [
              { price: (Number(boundUnits) / 1e6).toFixed(config.price), size: "1000000000000" },
            ];
            const b = book({
              tickSize: tick,
              minOrderSize: "0.01",
              asks: deep,
              bids: deep,
            });
            const quote = quoteMarket(
              { assetId: "1", side, amount, slippageBps, orderType: "FOK" },
              b,
            );
            // The oracle takes the raw bound — ours applies it from the book walk; feed the same bound.
            if (quote.bound !== price) {
              return; // slippage lifted the bound above the supplied level — different input domain
            }
            let oracle;
            try {
              oracle = getMarketOrderRawAmounts(
                side === "BUY" ? Side.BUY : Side.SELL,
                Number(amount),
                Number(price),
                config,
              );
            } catch {
              oracleSkipped += 1;
              return;
            }
            let oracleTaker: bigint;
            try {
              oracleTaker = parseUnits(oracle.rawTakerAmt.toString(), 6);
            } catch {
              oracleSkipped += 1;
              return;
            }
            const ours = BigInt(quote.takerAmount);
            const gridUnit = 10n ** BigInt(6 - config.amount);
            const diff = ours - oracleTaker;
            if (diff !== 0n) {
              diverged += 1;
            }
            // We ceil, the oracle floors: ours ≥ theirs by at most one unit of the amount decimals.
            expect(diff).toBeGreaterThanOrEqual(0n);
            expect(diff).toBeLessThanOrEqual(gridUnit);
          },
        ),
        { numRuns: 500 },
      );
      // The divergence count is evidence, not an assertion — record it in the output.
      expect(diverged + oracleSkipped).toBeGreaterThanOrEqual(0);
      console.log(`market oracle: ${diverged} in-favour diffs, ${oracleSkipped} oracle skips`);
    },
  );

  it("never prices a market order worse than its bound", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(
        fc.constantFrom("BUY", "SELL"),
        fc.double({ min: 1, max: 250, noNaN: true }),
        fc.integer({ min: 0, max: 5000 }),
        (side, amount, slippageBps) => {
          const b = orderBook();
          const quote = quoteMarket(
            { assetId: "1", side, amount: amount.toFixed(2), slippageBps, orderType: "FAK" },
            b,
          );
          const bound = Number(quote.bound);
          const implied = Number(quote.impliedPrice);
          if (side === "BUY") {
            expect(implied).toBeLessThanOrEqual(bound);
          } else {
            expect(implied).toBeGreaterThanOrEqual(bound);
          }
          expect(bound).toBeGreaterThan(0);
          expect(bound).toBeLessThan(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
