import { readFileSync } from "node:fs";

/**
 * Builder parity with the phase-1 signing vectors: for every `l1` case whose action the builders
 * can express, equivalent inputs must yield the exact same wire object — key order included, so the
 * comparison is `JSON.stringify`. The builders always mint a cloid (`random(16)`); `c` is stripped
 * from both sides of the compare and asserted byte-equal whenever the vector carries one.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { createHyperliquidActions } from "../src/apps/hyperliquid/actions.ts";
import type { HyperliquidActions } from "../src/apps/hyperliquid/actions.ts";
import type { HyperliquidMarkets } from "../src/apps/hyperliquid/markets.ts";

type WireOrder = {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t:
    | { readonly limit: { readonly tif: string } }
    | {
        readonly trigger: {
          readonly isMarket: boolean;
          readonly triggerPx: string;
          readonly tpsl: "tp" | "sl";
        };
      };
  readonly c?: string;
};

type WireAction = Record<string, unknown> & { readonly type: string };

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../vectors/chains/hyperliquid.json", import.meta.url), "utf8"),
) as { l1: ReadonlyArray<{ name: string; action: WireAction }> };

/** A fake main-DEX meta: index i is "COINi" with generous decimals, no spot pairs. */
const stubMarkets = (): HyperliquidMarkets => {
  const universe = Array.from({ length: 16 }, (_, i) => ({
    name: `COIN${i}`,
    szDecimals: 4,
    maxLeverage: 50,
    onlyIsolated: false,
  }));
  return {
    perps: async () => Promise.resolve([{ universe }, []]),
    spot: async () => Promise.resolve([{ universe: [], tokens: [] }, []]),
    mids: async () => Promise.resolve({}),
  } as unknown as HyperliquidMarkets;
};

const builders = (cloidBytes?: Uint8Array): HyperliquidActions =>
  createHyperliquidActions({
    markets: stubMarkets(),
    random: (length) => cloidBytes?.slice(0, length) ?? new Uint8Array(length).fill(0),
    now: () => 0,
  });

const stripC = (action: unknown): unknown => {
  if (typeof action !== "object" || action === null || !("orders" in action)) {
    return action;
  }
  const { orders, ...rest } = action as { orders: ReadonlyArray<Record<string, unknown>> };
  return {
    ...rest,
    orders: orders.map(({ c: _c, ...order }) => order),
  };
};

const orderParams = (order: WireOrder) => ({
  coin: `COIN${order.a}`,
  side: order.b ? ("buy" as const) : ("sell" as const),
  size: order.s,
  reduceOnly: order.r,
  order:
    "limit" in order.t
      ? {
          kind: "limit" as const,
          price: order.p,
          tif: order.t.limit.tif as "Gtc" | "Ioc" | "Alo",
        }
      : {
          kind: "trigger" as const,
          tpsl: order.t.trigger.tpsl,
          triggerPx: order.t.trigger.triggerPx,
          market: order.t.trigger.isMarket,
          price: order.p,
        },
});

const equivalent = async (action: WireAction, actions: HyperliquidActions): Promise<unknown> => {
  switch (action.type) {
    case "order": {
      const orders = action["orders"] as ReadonlyArray<WireOrder>;
      const grouping = action["grouping"] as string;
      if (orders.length !== 1 || grouping !== "na" || "builder" in action) {
        return undefined; // attached children / builder fees are built differently
      }
      const [wire] = orders;
      if (wire === undefined || ("limit" in wire.t && wire.t.limit.tif === "FrontendMarket")) {
        return undefined;
      }
      const built = await actions.place(orderParams(wire));
      return built.action;
    }
    case "cancel": {
      if ("f" in action) {
        return undefined; // the fast-cancel flag is unused by the builders
      }
      const cancels = action["cancels"] as ReadonlyArray<{ a: number; o: number }>;
      return actions.cancel(cancels.map((item) => ({ coin: `COIN${item.a}`, oid: item.o })));
    }
    case "cancelByCloid": {
      const cancels = action["cancels"] as ReadonlyArray<{ asset: number; cloid: string }>;
      return actions.cancelByCloid(
        cancels.map((item) => ({ coin: `COIN${item.asset}`, cloid: item.cloid })),
      );
    }
    case "modify": {
      const order = action["order"] as WireOrder;
      return actions.modify({
        oid: action["oid"] as number | string,
        ...orderParams(order),
      });
    }
    case "batchModify": {
      const modifies = action["modifies"] as ReadonlyArray<{
        oid: number | string;
        order: WireOrder;
      }>;
      return actions.batchModify(
        modifies.map((item) => ({ oid: item.oid, ...orderParams(item.order) })),
      );
    }
    case "updateLeverage":
      return actions.setLeverage({
        coin: `COIN${action["asset"] as number}`,
        leverage: action["leverage"] as number,
        marginMode: action["isCross"] === true ? "cross" : "isolated",
      });

    case "updateIsolatedMargin": {
      const ntli = action["ntli"] as number;
      return actions.adjustMargin({
        coin: `COIN${action["asset"] as number}`,
        amount: (ntli / 1_000_000).toString(),
      });
    }
    case "twapCancel":
      return actions.twapCancel({
        coin: `COIN${action["a"] as number}`,
        twapId: action["t"] as number,
      });

    default:
      return undefined;
  }
};

/** Build and compare one vector — returns how the case was counted. */
const checkVector = async (
  vector: (typeof VECTORS.l1)[number],
): Promise<"compared" | "skipped"> => {
  const cloid = (vector.action["orders"] as ReadonlyArray<WireOrder> | undefined)?.[0]?.c;
  const actions = builders(cloid === undefined ? undefined : hexToBytes(cloid.slice(2)));
  const built = await equivalent(vector.action, actions);
  if (built === undefined) {
    return "skipped";
  }
  expect(JSON.stringify(stripC(built)), `${vector.name} built a different wire action`).toBe(
    JSON.stringify(stripC(vector.action)),
  );
  if (cloid !== undefined) {
    const { orders } = built as { orders: ReadonlyArray<{ c?: string }> };
    expect(orders[0]?.c, `${vector.name} minted a different cloid`).toBe(cloid);
  }
  return "compared";
};

describe("hyperliquid action builders vs phase-1 vectors", () => {
  it("every expressible vector builds the exact same wire action", async () => {
    let compared = 0;
    for (const vector of VECTORS.l1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases keep failures attributable.
      const outcome = await checkVector(vector);
      compared += Number(outcome === "compared");
    }
    // Coverage is asserted, not the count: every case is compared or deliberately out.
    expect(compared).toBeGreaterThan(0);
  });
});
