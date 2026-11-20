import { describe, expect, it } from "vite-plus/test";

import { historyPath, prices, rpcPath, rpcRequestCost } from "@qntx/wallet-engine/gateway/contract";

import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import type { GatewayNetwork, RateLimiter } from "../src/types.ts";
import {
  CLIENT_ID,
  SEPOLIA,
  allowAll,
  call,
  countBefore,
  fakeFetch,
  gateway,
  headers,
  memoryPriceCache,
  rpcOk,
} from "./helpers.ts";

/**
 * R4 audit proofs: rate-limit behaviour an attacker provokes at HEAD. Every test asserts the
 * problematic behaviour, so they all pass at HEAD — a fix makes them fail.
 *
 * Production limiter bindings (apps/gateway/wrangler.jsonc): ip 300, default 50, rpc 100 per 10 s.
 */

const ETH = "eip155:1";
const ALCHEMY = "https://alchemy.test/eth";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const IP = "203.0.113.7";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  {
    id: SEPOLIA,
    providers: [
      { id: "a", url: "https://a.test/evm" },
      { id: "b", url: "https://b.test/evm" },
    ],
  },
  { id: ETH, providers: [{ id: "alchemy", url: ALCHEMY }] },
];

/** A fresh 32-hex `x-client-id` per request — the client picks it, so rotation is free. */
const freshId = (n: number): string => n.toString(16).padStart(32, "0");

const jsonPost = (clientId: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: headers({
    "content-type": "application/json",
    "cf-connecting-ip": IP,
    "x-client-id": clientId,
  }),
  body: JSON.stringify(body),
});

/** An empty Alchemy transfers page: two upstream calls per page, no drain. */
const emptyTransfers = (): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [] } });

/** Refuses every charge once `units` have already been counted; earlier charges stay spent. */
const refuseOnceCharged = (units: number): RateLimiter => {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key, delta = 1 }) => {
      await Promise.resolve();
      const count = counts.get(key) ?? 0;
      if (count >= units) {
        return { success: false };
      }
      counts.set(key, count + delta);
      return { success: true };
    },
  };
};

describe("R4-G1 one IPv4 /24 with rotating client ids spends the shared provider budget", () => {
  it("history: 150 pages / 300 upstream calls before the first 429 (ip 300, default 50)", async () => {
    const up = fakeFetch({ [ALCHEMY]: emptyTransfers });
    const defaultLimiter = countBefore(50);
    const app = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: countBefore(300), rpc: countBefore(100), default: defaultLimiter },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 160; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential client on purpose
      const res = await app.request(historyPath(ETH), jsonPost(freshId(i), { address: OWNER }));
      statuses.push(res.status);
    }
    const pages = statuses.filter((s) => s === 200).length;
    const calls = up.callsTo(ALCHEMY).length;
    expect(pages).toBe(150);
    expect(statuses[150]).toBe(429);
    expect(calls).toBe(300);
    // Every rotated client id got its own `${clientId}:${prefix}` key and spent 2 of 50 — the
    // per-install binding never engaged; only the /24 limiter bounded anything.
    expect(defaultLimiter.counts.size).toBe(150);
    expect([...defaultLimiter.counts.values()].every((count) => count === 2)).toBe(true);
    console.log(
      `R4-G1 history: /24 ${IP}, rotating client ids -> ${String(pages)} pages of 200, ` +
        `${String(calls)} alchemy_getAssetTransfers calls ≈ ${String(calls * 120)} CU before 429`,
    );
  });

  it("rpc: 30 eth_getLogs calls before the first 429 (ip 300, rpc 100)", async () => {
    const blockHash = `0x${"ab".repeat(32)}`;
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const rpcLimiter = countBefore(100);
    const app = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: countBefore(300), rpc: rpcLimiter, default: allowAll },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential client on purpose
      const res = await app.request(
        rpcPath(SEPOLIA),
        jsonPost(freshId(i), call("eth_getLogs", [{ blockHash }])),
      );
      statuses.push(res.status);
    }
    const served = statuses.filter((s) => s === 200).length;
    const calls = up.callsTo("https://a.test/evm").length;
    expect(served).toBe(30);
    expect(statuses[30]).toBe(429);
    expect(calls).toBe(30);
    // Each rotated id spent 10 of 100 units on its own key; the rpc binding never refused.
    expect(rpcLimiter.counts.size).toBe(30);
    expect([...rpcLimiter.counts.values()].every((count) => count === 10)).toBe(true);
    console.log(
      `R4-G1 rpc: /24 ${IP}, rotating client ids -> ${String(served)} eth_getLogs of 200, ` +
        `≈ ${String(calls * 60)} CU before 429`,
    );
  });
});

describe("R4-G2 count-before admits one request costing more than the whole budget", () => {
  const limiters = () => ({ ip: countBefore(300), rpc: countBefore(100), default: allowAll });

  it("eth_getProof with 5000 storage keys costs 1500 units and is forwarded whole", async () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);
    const body = call("eth_getProof", [OWNER, keys, "latest"]);
    expect(JSON.stringify(body).length).toBeLessThan(512 * 1024);
    expect(rpcRequestCost(body)).toBe(1500);

    const up = fakeFetch({ "https://a.test/evm": () => rpcOk({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, limiters: limiters() });
    const res = await app.request(rpcPath(SEPOLIA), jsonPost(CLIENT_ID, body));
    expect(res.status).toBe(200);
    const keyCounts = up.calls.map(
      (c) => (JSON.parse(c.body) as { params: [string, string[]] }).params[1].length,
    );
    expect(keyCounts).toStrictEqual([5000]);

    const next = await app.request(rpcPath(SEPOLIA), jsonPost(CLIENT_ID, call("eth_chainId")));
    expect(next.status).toBe(429);
    console.log(
      `R4-G2 eth_getProof: cost 1500 units vs limits ip=300 rpc=100 -> admitted (200), ` +
        `5000 keys reached upstream; next request 429`,
    );
  });

  it("eth_simulateV1 with 3000 calls costs 9000 units and is forwarded whole", async () => {
    const calls = Array.from({ length: 3000 }, () => ({ to: `0x${"0".repeat(40)}` }));
    const body = call("eth_simulateV1", [{ blockStateCalls: [{ calls }] }]);
    expect(JSON.stringify(body).length).toBeLessThan(512 * 1024);
    expect(rpcRequestCost(body)).toBe(9000);

    const up = fakeFetch({ "https://a.test/evm": () => rpcOk({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, limiters: limiters() });
    const res = await app.request(rpcPath(SEPOLIA), jsonPost(CLIENT_ID, body));
    expect(res.status).toBe(200);
    const callCounts = up.calls.map(
      (c) =>
        (JSON.parse(c.body) as { params: [{ blockStateCalls: [{ calls: unknown[] }] }] }).params[0]
          .blockStateCalls[0].calls.length,
    );
    expect(callCounts).toStrictEqual([3000]);

    const next = await app.request(rpcPath(SEPOLIA), jsonPost(CLIENT_ID, call("eth_chainId")));
    expect(next.status).toBe(429);
    console.log(
      `R4-G2 eth_simulateV1: cost 9000 units vs limits ip=300 rpc=100 -> admitted (200), ` +
        `3000 calls reached upstream; next request 429`,
    );
  });
});

describe("R4-G3 a refused second-source charge throws away the first source's paid answer", () => {
  const COIN = "eip155:1/slip44:60";
  const TOKEN = "eip155:1/erc20:0x1111111111111111111111111111111111111111";
  const LLAMA_KEY = "ethereum:0x1111111111111111111111111111111111111111";
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const upstreams = () =>
    fakeFetch({
      [COINGECKO_API]: (c) =>
        c.url.includes("token_price")
          ? // CoinGecko does not know the ERC-20: DefiLlama is needed for it.
            Response.json({})
          : Response.json({
              ethereum: { usd: 3000, usd_24h_change: 1.5, last_updated_at: nowSeconds() },
            }),
      [DEFILLAMA_API]: (c) =>
        c.url.includes("/percentage/")
          ? Response.json({ coins: { [LLAMA_KEY]: 2.5 } })
          : Response.json({
              coins: { [LLAMA_KEY]: { price: 1.25, timestamp: nowSeconds(), confidence: 0.999 } },
            }),
    });

  const requestBody = { currency: "usd", assets: [COIN, TOKEN] };

  it("429 on the DefiLlama charge discards the CoinGecko answer; it is re-fetched next time", async () => {
    const up = upstreams();
    const cache = memoryPriceCache();
    // Default binding accepts the request (1) + CoinGecko's two calls (2), then refuses the
    // DefiLlama charge (2 more).
    const refused = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: refuseOnceCharged(3) },
      prices: { cache, coingecko: { apiKey: "k" } },
    });
    const first = await refused.request(prices.path, jsonPost(CLIENT_ID, requestBody));
    expect(first.status).toBe(429);
    const coingeckoCallsFirst = up.callsTo(COINGECKO_API).length;
    expect(coingeckoCallsFirst).toBe(2);
    // The DefiLlama charge was refused before its calls were sent…
    expect(up.callsTo(DEFILLAMA_API)).toHaveLength(0);
    // …and the paid CoinGecko answer was never written to the cache.
    expect(cache.data.size).toBe(0);

    const allowed = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll },
      prices: { cache, coingecko: { apiKey: "k" } },
    });
    const second = await allowed.request(prices.path, jsonPost(CLIENT_ID, requestBody));
    expect(second.status).toBe(200);
    // CoinGecko paid again for the same answer.
    expect(up.callsTo(COINGECKO_API)).toHaveLength(4);
    expect(cache.data.has(`usd/${COIN}`)).toBe(true);
    console.log(
      `R4-G3 prices: DefiLlama charge refused after CoinGecko paid (${String(
        coingeckoCallsFirst,
      )} calls, 0 cached) -> 429; second request re-fetched CoinGecko ` +
        `(${String(up.callsTo(COINGECKO_API).length)} calls total)`,
    );
  });
});
