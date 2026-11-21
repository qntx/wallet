/**
 * The `hyperliquidL1Action` wire schema bounds: the builder fee is capped at 1000 (0.1 %), and
 * `grouping` admits only the three free groupings — a priority-fee `{p}` grouping is refused.
 */
import { describe, expect, it } from "vite-plus/test";

import { hyperliquidL1Action } from "../../src/protocol/apps.ts";
import { validate } from "../../src/protocol/validate.ts";

const ORDER = {
  type: "order",
  orders: [{ a: 0, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
};

const order = (overrides: Record<string, unknown>) => ({ ...ORDER, ...overrides });

describe("hyperliquidL1Action bounds", () => {
  it("builder fee 1000 is accepted and 1001 is refused", () => {
    const builder = { b: "0x00000000000000000000000000000000deadbeef" };
    expect(
      validate(hyperliquidL1Action, order({ grouping: "na", builder: { ...builder, f: 1000 } })),
    ).toBeDefined();
    expect(
      validate(hyperliquidL1Action, order({ grouping: "na", builder: { ...builder, f: 1001 } })),
    ).toBeUndefined();
  });

  it.each(["na", "normalTpsl", "positionTpsl"])("grouping %s is accepted", (grouping) => {
    expect(validate(hyperliquidL1Action, order({ grouping }))).toBeDefined();
  });

  it("the priority-fee grouping p is refused", () => {
    expect(validate(hyperliquidL1Action, order({ grouping: "p" }))).toBeUndefined();
  });
});
