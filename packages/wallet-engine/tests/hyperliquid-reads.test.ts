import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * Every info read replays its recorded real response: the injected fetch asserts the exact request
 * body the fixture was recorded with and answers the fixture's raw response — so the read functions
 * are checked against live wire data on both networks.
 */
import { createHyperliquidProvider } from "../src/apps/hyperliquid/provider.ts";
import type { HyperliquidProvider } from "../src/apps/hyperliquid/provider.ts";

type Fixture = {
  readonly request: unknown;
  readonly fetchedAt: number;
  readonly response: unknown;
};

const fixture = (network: string, name: string): Fixture =>
  JSON.parse(
    readFileSync(new URL(`fixtures/hyperliquid/${network}/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;

const FIXTURE_NAMES = [
  "metaAndAssetCtxs",
  "spotMetaAndAssetCtxs",
  "l2Book",
  "candleSnapshot",
  "recentTrades",
  "fundingHistory",
  "predictedFundings",
  "allMids",
  "clearinghouseState",
  "spotClearinghouseState",
  "frontendOpenOrders",
  "userFills",
  "userFunding",
  "portfolio",
  "userRateLimit",
  "userFees",
  "extraAgents",
  "maxBuilderFee",
  "userRole",
  "orderStatus",
  "orderStatus-unknown",
] as const;

const FIXTURES = {
  mainnet: FIXTURE_NAMES.map((name) => fixture("mainnet", name)),
  testnet: FIXTURE_NAMES.map((name) => fixture("testnet", name)),
};

const ACCOUNTS = {
  mainnet: fixture("mainnet", "_account") as unknown as { user: string; oid: number },
  testnet: fixture("testnet", "_account") as unknown as { user: string; oid: number },
};

const requireFixture = (network: "mainnet" | "testnet", type: string): Fixture => {
  const found = FIXTURES[network].find((f) => (f.request as { type: string }).type === type);
  if (found === undefined) {
    throw new Error(`no ${type} fixture for ${network}`);
  }
  return found;
};

const startTime = (network: "mainnet" | "testnet", name: string): number => {
  const request = requireFixture(network, name).request as {
    startTime?: number;
    req?: { startTime: number };
  };
  const value = request.startTime ?? request.req?.startTime;
  if (value === undefined) {
    throw new Error(`no startTime in ${name} fixture`);
  }
  return value;
};

/** A fetch that serves the fixture whose request matches — anything else fails the test. */
const fixtureFetch =
  (fixtures: ReadonlyArray<Fixture>): typeof globalThis.fetch =>
  async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(url.endsWith("/info")).toBe(true);
    const body = JSON.parse(String(init?.body)) as unknown;
    const found = fixtures.find((f) => JSON.stringify(f.request) === JSON.stringify(body));
    if (found === undefined) {
      throw new Error(`unrecorded request: ${JSON.stringify(body)}`);
    }
    return Response.json(found.response, {
      status: 200,
      headers: { date: new Date(found.fetchedAt).toUTCString() },
    });
  };

const HL_NETWORK = { mainnet: "Mainnet", testnet: "Testnet" } as const;

const provider = (network: "mainnet" | "testnet"): HyperliquidProvider =>
  createHyperliquidProvider({
    network: HL_NETWORK[network],
    fetch: fixtureFetch(FIXTURES[network]),
    now: () => 1_800_000_000_000,
    setTimer: () => () => undefined,
  });

describe.each(["mainnet", "testnet"] as const)("hyperliquid reads (%s)", (network) => {
  const p = provider(network);
  const { user } = ACCOUNTS[network];

  it("market reads replay the recorded responses", async () => {
    const [meta, assetCtxs] = await p.markets.perps();
    expect(meta.universe.length).toBeGreaterThan(0);
    expect(assetCtxs).toHaveLength(meta.universe.length);
    const [spotMeta, spotCtxs] = await p.markets.spot();
    expect(spotMeta.universe.length).toBeGreaterThan(0);
    expect(spotCtxs.length).toBeGreaterThan(0);
    const book = await p.markets.book({ coin: "BTC" });
    expect(book?.coin).toBe("BTC");
    expect(book?.levels[0]?.length).toBeGreaterThan(0);
    const candleReq = (
      requireFixture(network, "candleSnapshot").request as {
        req: { coin: string; interval: "1h"; startTime: number; endTime: number };
      }
    ).req;
    const candles = await p.markets.candles(candleReq);
    expect(candles.length).toBeGreaterThan(0);
    const trades = await p.markets.trades({ coin: "BTC" });
    expect(trades.length).toBeGreaterThan(0);
    const funding = await p.markets.fundingHistory({
      coin: "BTC",
      startTime: startTime(network, "fundingHistory"),
    });
    expect(funding.length).toBeGreaterThan(0);
    const predicted = await p.markets.predictedFundings();
    expect(predicted.length).toBeGreaterThan(0);
    const mids = await p.markets.mids();
    expect(Object.keys(mids).length).toBeGreaterThan(0);
  });

  it("account reads replay the recorded responses", async () => {
    await p.account.state({ user });
    await p.account.spot({ user });
    await p.account.openOrders({ user });
    const fills = await p.account.fills({ user });
    expect(fills.length).toBeGreaterThan(0);
    await p.account.funding({ user, startTime: startTime(network, "userFunding") });
    await p.account.portfolio(user);
    await p.account.rateLimit(user);
    await p.account.fees(user);
    await p.account.extraAgents(user);
    await p.account.maxBuilderFee(user, user);
    const role = await p.account.role(user);
    expect(["missing", "user", "agent", "vault", "subAccount"]).toContain(role.role);
  });

  it("orderStatus finds a recorded oid and reports an unknown one", async () => {
    const found = await p.account.orderStatus({ user, oid: ACCOUNTS[network].oid });
    expect(found.status).toBe("order");
    const unknown = await p.account.orderStatus({ user, oid: 9_999_999_999_999 });
    expect(unknown.status).toBe("unknownOid");
  });

  it("the Date header feeds the skew estimate", async () => {
    const p2 = createHyperliquidProvider({
      network: HL_NETWORK[network],
      fetch: fixtureFetch(FIXTURES[network]),
      now: () => 1_800_000_000_000,
      setTimer: () => () => undefined,
    });
    expect(p2.clock.skew()).toBeUndefined();
    await p2.markets.mids();
    const { fetchedAt } = requireFixture(network, "allMids");
    // The Date header is whole seconds; +500 centres the estimate, midpoint is `now` exactly.
    const serverMs = Math.floor(fetchedAt / 1000) * 1000;
    expect(p2.clock.skew()).toBe(serverMs + 500 - 1_800_000_000_000);
  });
});
