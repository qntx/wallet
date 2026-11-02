import { describe, expect, it } from "vite-plus/test";

import type { EvmFeeQuote } from "../src/chains/evm.ts";
import {
  FEE_CAP_MULTIPLIER,
  FEE_MISMATCH_PERCENT,
  collectChecks,
  exceedsNetworkCap,
  feeReachesAmount,
  feesDiffer,
  mergeEvmQuote,
  mergeSatPerByte,
  mergeSolanaQuote,
} from "../src/requests/checks.ts";

const q1559 = (baseFee: bigint, priority: bigint): EvmFeeQuote => ({
  tier: "normal",
  wei: baseFee * 2n + priority,
  maxFeePerGas: baseFee * 2n + priority,
  maxPriorityFeePerGas: priority,
});
const legacy = (price: bigint): EvmFeeQuote => ({
  tier: "normal",
  wei: price,
  maxFeePerGas: price,
  maxPriorityFeePerGas: undefined,
});

describe("thresholds", () => {
  it("are 25 percent and 2x", () => {
    expect(FEE_MISMATCH_PERCENT).toBe(25n);
    expect(FEE_CAP_MULTIPLIER).toBe(2n);
  });
});

describe("feesDiffer", () => {
  it.each([
    ["equal", 100n, 100n, false],
    ["both zero", 0n, 0n, false],
    ["exactly 25% above the smaller", 100n, 125n, false],
    ["exactly 25%, reversed", 125n, 100n, false],
    ["just over 25%", 100n, 126n, true],
    ["one unit over on a large value", 1_000_000n, 1_250_001n, true],
    ["zero against non-zero", 0n, 1n, true],
    ["non-zero against zero", 7n, 0n, true],
    ["24%", 100n, 124n, false],
    ["2x", 100n, 200n, true],
  ])("%s", (_name, a, b, expected) => {
    expect(feesDiffer(a, b)).toBe(expected);
  });
});

describe("exceedsNetworkCap", () => {
  it.each([
    [200n, 100n, false],
    [201n, 100n, true],
    [0n, 0n, false],
    [1n, 0n, true],
    [99n, 100n, false],
  ])("final %s vs independent %s", (final, independent, expected) => {
    expect(exceedsNetworkCap(final, independent)).toBe(expected);
  });
});

describe("feeReachesAmount", () => {
  it.each([
    [99n, 100n, false],
    [100n, 100n, true],
    [101n, 100n, true],
  ])("fee %s vs amount %s", (fee, amount, expected) => {
    expect(feeReachesAmount(fee, amount)).toBe(expected);
  });
});

describe("mergeEvmQuote", () => {
  it("agreeing 1559 quotes: lower priority, higher base, no mismatch", () => {
    const { quote, mismatch } = mergeEvmQuote(q1559(100n, 10n), q1559(110n, 11n));
    expect(mismatch).toBe(false);
    expect(quote.maxPriorityFeePerGas).toBe(10n);
    expect(quote.maxFeePerGas).toBe(110n * 2n + 10n);
  });

  it("a gateway inflating the priority fee: host's lower value wins, mismatch recorded", () => {
    const { quote, mismatch } = mergeEvmQuote(q1559(100n, 1000n), q1559(100n, 10n));
    expect(mismatch).toBe(true);
    expect(quote.maxPriorityFeePerGas).toBe(10n);
  });

  it("a gateway inflating the base fee: ceiling follows the higher base, mismatch recorded", () => {
    const { quote, mismatch } = mergeEvmQuote(q1559(1000n, 10n), q1559(100n, 10n));
    expect(mismatch).toBe(true);
    expect(quote.maxFeePerGas).toBe(1000n * 2n + 10n);
  });

  it("priority exactly 25% apart is not a mismatch", () => {
    expect(mergeEvmQuote(q1559(100n, 100n), q1559(100n, 125n)).mismatch).toBe(false);
    expect(mergeEvmQuote(q1559(100n, 100n), q1559(100n, 126n)).mismatch).toBe(true);
  });

  it("zero priority on both sides agrees", () => {
    const { quote, mismatch } = mergeEvmQuote(q1559(100n, 0n), q1559(100n, 0n));
    expect(mismatch).toBe(false);
    expect(quote.maxPriorityFeePerGas).toBe(0n);
  });

  it("legacy gasPrice: lower price, mismatch past 25%", () => {
    expect(mergeEvmQuote(legacy(100n), legacy(120n))).toMatchObject({
      quote: { maxFeePerGas: 100n, maxPriorityFeePerGas: undefined },
      mismatch: false,
    });
    expect(mergeEvmQuote(legacy(500n), legacy(100n))).toMatchObject({
      quote: { maxFeePerGas: 100n },
      mismatch: true,
    });
  });

  it("mixed shapes cannot be merged: the independent quote wins and it is a mismatch", () => {
    const independent = legacy(50n);
    expect(mergeEvmQuote(q1559(100n, 10n), independent)).toStrictEqual({
      quote: independent,
      mismatch: true,
    });
  });
});

describe("mergeSolanaQuote", () => {
  const sol = (microLamportsPerCu: bigint) => ({ tier: "normal" as const, microLamportsPerCu });

  it.each([
    ["agree", 1000n, 1100n, 1000n, false],
    ["gateway inflated", 5000n, 1000n, 1000n, true],
    ["gateway low", 1000n, 5000n, 1000n, true],
    ["exactly 25%", 1000n, 1250n, 1000n, false],
    ["both zero", 0n, 0n, 0n, false],
    ["zero vs non-zero", 0n, 10n, 0n, true],
  ])("%s", (_name, a, b, lower, mismatch) => {
    expect(mergeSolanaQuote(sol(a), sol(b))).toStrictEqual({ quote: sol(lower), mismatch });
  });
});

describe("mergeSatPerByte", () => {
  it.each([
    ["agree", 10, 11, 10, false],
    ["gateway inflated", 100, 10, 10, true],
    ["exactly 25%", 8, 10, 8, false],
    ["fractional rates compare by their ceiling", 1.2, 2, 1.2, false],
    ["fractional rates, ceilings apart", 1.2, 3, 1.2, true],
    ["floor of 1 sat/vB on both", 1, 1, 1, false],
  ])("%s", (_name, a, b, rate, mismatch) => {
    expect(mergeSatPerByte(a, b)).toStrictEqual({ rate, mismatch });
  });
});

describe("collectChecks", () => {
  it("drops undefined and duplicates, keeps first-seen order", () => {
    expect(
      collectChecks(["fee-mismatch", undefined, "reads-unverified", "fee-mismatch"]),
    ).toStrictEqual(["fee-mismatch", "reads-unverified"]);
    expect(collectChecks([undefined])).toStrictEqual([]);
  });
});
