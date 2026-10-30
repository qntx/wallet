import { describe, expect, it } from "vite-plus/test";

import { dustFor, feeTiers, isFrozen, validateEndpoint } from "../src/chains/bitcoin.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";

const es = (handlers: Record<string, unknown>): Esplora => ({
  get: async (path) => {
    const v = handlers[path];
    return v === undefined ? Promise.reject(new Error(`unmocked ${path}`)) : Promise.resolve(v);
  },
  post: async () => Promise.reject(new Error("unmocked")),
});

describe("bitcoin adapter", () => {
  it("fee tiers pick 1/3/6/144 with a 1 sat/vB floor", async () => {
    const quotes = await feeTiers(
      es({ "/fee-estimates": { "1": 12.4, "3": 5, "6": 2, "144": 0.4 } }),
    );
    expect(quotes.map((q) => [q.tier, q.satPerByte])).toStrictEqual([
      ["fast", 13],
      ["normal", 5],
      ["slow", 2],
      ["economy", 1],
    ]);
  });

  it("dust floors per output type and the 546/330-sat freeze", () => {
    expect(dustFor("p2wpkh")).toBe(294);
    expect(dustFor("p2tr")).toBe(330);
    expect(dustFor("p2pkh")).toBe(546);
    expect(isFrozen(546)).toBe(true);
    expect(isFrozen(330)).toBe(true);
    expect(isFrozen(1000)).toBe(false);
  });

  it("rejects an endpoint whose genesis hash mismatches the registry", async () => {
    await expect(validateEndpoint(es({ "/block-height/0": "deadbeef" }), "0000aa")).rejects.toThrow(
      "genesis",
    );
    await expect(
      validateEndpoint(es({ "/block-height/0": "0000aa" }), "0000aa"),
    ).resolves.toBeUndefined();
  });
});
