import { describe, expect, it } from "vite-plus/test";

import { createHyperliquidClock } from "../src/apps/hyperliquid/clock.ts";
import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";

const throws = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof HyperliquidError ? error.category : "foreign";
  }
};

describe("hyperliquid clock", () => {
  it("an estimate at exactly the bound signs; one past it — either direction — is clock-skew", () => {
    const clock = createHyperliquidClock(() => 0);
    /* estimate = serverMs + 500 − midpoint(start, end); the bound is a literal 5000 ms — the
       numbers must not derive from the constant or a bumped bound hides the difference. */
    clock.record(4500, 0, 0); // +5000 exactly
    expect(throws(() => clock.assertSkew())).toBeUndefined();
    clock.record(0, 0, 11_000); // −5000 exactly
    expect(throws(() => clock.assertSkew())).toBeUndefined();
    clock.record(4501, 0, 0); // +5001
    expect(throws(() => clock.assertSkew())).toBe("clock-skew");
    clock.record(0, 0, 11_002); // −5001
    expect(throws(() => clock.assertSkew())).toBe("clock-skew");
  });

  it("the estimate is the whole-second server time plus a half second against the request midpoint", () => {
    const clock = createHyperliquidClock(() => 0);
    /* A midpoint that is neither endpoint pins the formula: response-end only would give 2000 +
       500 − 100, request-start only 2000 + 500 − 0, no centring 2000 − 50. */
    clock.record(2000, 0, 100);
    expect(clock.skew()).toBe(2000 + 500 - 50);
  });

  it("no estimate never refuses", () => {
    const clock = createHyperliquidClock(() => 0);
    expect(clock.skew()).toBeUndefined();
    expect(throws(() => clock.assertSkew())).toBeUndefined();
  });

  it("the nonce never repeats per signer and never goes backwards", () => {
    let now = 1_800_000_000_000;
    const clock = createHyperliquidClock(() => now);
    const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(clock.nextNonce(a)).toBe(now);
    now -= 60_000; // device clock jumps backwards
    expect(clock.nextNonce(a)).toBe(now + 60_000 + 1);
    expect(clock.nextNonce(b)).toBe(now);
    expect(clock.nextNonce(a)).toBe(now + 60_000 + 2);
  });
});
