import { describe, expect, it } from "vite-plus/test";

import {
  bridgeQuote,
  health,
  historyPath,
  phishingListPath,
  prices,
  rpcPath,
  servedNetworks,
  swapQuote,
  swapQuoteSolana,
} from "@qntx/wallet-engine/gateway/contract";

import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import type { GatewayNetwork } from "../src/types.ts";
import { SEPOLIA, SIGNET, call, fakeFetch, gateway, headers, post } from "./helpers.ts";
import type { Upstream } from "./helpers.ts";

const ETH = "eip155:1";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ALCHEMY = "https://alchemy.test/eth";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  {
    id: SEPOLIA,
    providers: [
      { id: "a", url: "https://a.test/evm" },
      { id: "b", url: "https://b.test/evm" },
    ],
  },
  {
    id: SIGNET,
    providers: [
      { id: "a", url: "https://a.test/btc" },
      { id: "b", url: "https://b.test/btc" },
    ],
  },
  { id: ETH, providers: [{ id: "alchemy", url: ALCHEMY }] },
];

const TAKER = "0x8f3796aa4dB3f47E0fE0D19f9c3c96a51aD5f0F8";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WSOL = "So11111111111111111111111111111111111111112";
const SUSDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STAKER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

type Forwarded = {
  /** The request a client sends to the route. */
  readonly request: readonly [path: string, init: RequestInit];
  /** Every upstream the route may call; the first is the one whose breaker the test watches. */
  readonly upstreams: readonly [string, ...string[]];
};

const get = (path: string): readonly [string, RequestInit] => [path, { headers: headers() }];

/**
 * Every route the gateway registers, by `METHOD path`: `null` for a route that never calls an
 * upstream, else a request that reaches one. A new route fails the enumeration test until it is
 * listed here — and then the two breaker tests below hold it to the forwarder's accounting.
 */
const ROUTES: Readonly<Record<string, Forwarded | null>> = {
  [`GET ${health.path}`]: null,
  "GET /v1/eligibility": null,
  [`GET ${servedNetworks.path}`]: null,
  [`GET ${phishingListPath}`]: null,
  "GET /v1/tokens/:caip2": null,
  "POST /v1/rpc/:caip2": {
    request: [rpcPath(SEPOLIA), post(call("eth_chainId"))],
    upstreams: ["https://a.test/evm", "https://b.test/evm"],
  },
  "POST /v1/history/:caip2": {
    request: [historyPath(ETH), post({ address: OWNER })],
    upstreams: [ALCHEMY],
  },
  "GET /v1/esplora/:caip2/*": {
    request: get(`/v1/esplora/${SIGNET}/fee-estimates`),
    upstreams: ["https://a.test/btc", "https://b.test/btc"],
  },
  "POST /v1/esplora/:caip2/*": {
    request: [
      `/v1/esplora/${SIGNET}/tx`,
      { method: "POST", headers: headers({ "content-type": "text/plain" }), body: "02000000" },
    ],
    upstreams: ["https://a.test/btc", "https://b.test/btc"],
  },
  [`GET ${swapQuote.path}`]: {
    request: get(
      `${swapQuote.path}?network=${SEPOLIA}&sellToken=${USDC}&buyToken=${WETH}&sellAmount=1000000&taker=${TAKER}&slippageBps=100`,
    ),
    upstreams: ["https://api.0x.org"],
  },
  [`GET ${swapQuoteSolana.path}`]: {
    request: get(
      `${swapQuoteSolana.path}?network=${SOLANA}&inputMint=${WSOL}&outputMint=${SUSDC}&amount=100000000&taker=${STAKER}&slippageBps=50`,
    ),
    upstreams: ["https://api.jup.ag"],
  },
  [`GET ${bridgeQuote.path}`]: {
    request: get(
      `${bridgeQuote.path}?network=eip155:1&destinationNetwork=eip155:10&inputToken=${USDC}&outputToken=0x0b2c639c533813f4aa9d7837caf62653d097ff85&amount=300000000&taker=${TAKER}`,
    ),
    upstreams: ["https://app.across.to"],
  },
  [`POST ${prices.path}`]: {
    request: [prices.path, post({ currency: "usd", assets: [`${ETH}/slip44:60`] })],
    upstreams: [COINGECKO_API, DEFILLAMA_API],
  },
};

/** A cache that never hits, so every request reaches the price upstreams. */
const noCache = {
  get: async () => Promise.resolve(undefined),
  put: async () => Promise.resolve(),
};

const appWith = (answer: Upstream) => {
  const forwarded = Object.values(ROUTES).filter((route): route is Forwarded => route !== null);
  const up = fakeFetch(
    Object.fromEntries(forwarded.flatMap((route) => route.upstreams.map((url) => [url, answer]))),
  );
  const app = gateway({
    fetch: up.fetch,
    networks: NETWORKS,
    zeroEx: { apiKey: "k" },
    prices: {
      cache: noCache,
      coingecko: { apiKey: "k" },
    },
  });
  return { app, up };
};

/** Upstream answers any client can provoke with its own input: never a provider outage. */
const REQUEST_ANSWERS: ReadonlyArray<readonly [string, Upstream]> = [
  ...[400, 401, 403, 404, 413, 422].map((status): readonly [string, Upstream] => [
    `status ${String(status)}`,
    () => new Response("rejected", { status }),
  ]),
  ["a malformed 200 body", () => new Response("<html>")],
  [
    "a JSON-RPC error",
    () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }),
  ],
  [
    "a body over every response cap",
    () => new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } }),
  ],
];

/** Failures only the provider owns: these, and only these, open its breaker. */
const OUTAGES: ReadonlyArray<readonly [string, Upstream]> = [
  ...[429, 500, 503].map((status): readonly [string, Upstream] => [
    `status ${String(status)}`,
    () => new Response("down", { status }),
  ]),
  [
    "a transport error",
    () => {
      throw new TypeError("connection reset");
    },
  ],
];

const forwardedRoutes = Object.entries(ROUTES).filter(
  (entry): entry is [string, Forwarded] => entry[1] !== null,
);

describe("shared upstream breakers", () => {
  it("lists every registered route", () => {
    const { app } = appWith(() => new Response("{}"));
    const registered = new Set(
      app.routes.filter((route) => route.method !== "ALL").map((r) => `${r.method} ${r.path}`),
    );
    expect([...registered].toSorted()).toStrictEqual(Object.keys(ROUTES).toSorted());
  });

  it.each([
    health.path,
    servedNetworks.path,
    phishingListPath,
    "/v1/eligibility",
    `/v1/tokens/${ETH}`,
  ])("GET %s never calls an upstream", async (path) => {
    const { app, up } = appWith(() => new Response("{}"));
    await app.request(path, { headers: headers() });
    expect(up.calls).toHaveLength(0);
  });

  describe.each(forwardedRoutes)("%s", (_key, { request, upstreams }) => {
    const [watched] = upstreams;

    it.each(REQUEST_ANSWERS)(
      "keeps its breaker closed after six requests answered with %s",
      async (_label, answer) => {
        const { app, up } = appWith(answer);
        for (let i = 0; i < 6; i += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- consecutive failures on purpose
          await app.request(...request);
        }
        const before = up.callsTo(watched).length;
        await app.request(...request);
        expect(up.callsTo(watched).length).toBeGreaterThan(before);
      },
    );

    it.each(OUTAGES)("opens its breaker after five outages of %s", async (_label, answer) => {
      const { app, up } = appWith(answer);
      for (let i = 0; i < 5; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- consecutive failures on purpose
        await app.request(...request);
      }
      const before = up.callsTo(watched).length;
      await app.request(...request);
      expect(up.callsTo(watched)).toHaveLength(before);
    });
  });
});

describe("history cursor bounds", () => {
  const transfersPage = () => Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [] } });

  it.each([
    ["2^64", (2n ** 64n).toString()],
    ["just above int64", "9223372036854775808"],
    ["20 digits", "9".repeat(20)],
  ])("refuses a %s cursor before any upstream call", async (_label, cursor) => {
    const up = fakeFetch({ [ALCHEMY]: transfersPage });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- consecutive requests on purpose
      const res = await app.request(historyPath(ETH), post({ address: OWNER, cursor }));
      statuses.push(res.status);
    }
    expect(statuses).toStrictEqual([400, 400, 400, 400, 400]);
    expect(up.calls).toHaveLength(0);
    const victim = await app.request(historyPath(ETH), post({ address: OWNER }));
    expect(victim.status).toBe(200);
  });

  it("forwards the largest accepted cursor as its hex block bound", async () => {
    const up = fakeFetch({ [ALCHEMY]: transfersPage });
    const res = await gateway({ fetch: up.fetch, networks: NETWORKS }).request(
      historyPath(ETH),
      post({ address: OWNER, cursor: "9223372036854775807" }),
    );
    expect(res.status).toBe(200);
    const bodies = up.calls.map(
      (c) => (JSON.parse(c.body) as { params: Array<{ toBlock: string }> }).params[0]?.toBlock,
    );
    expect(bodies).toStrictEqual(["0x7fffffffffffffff", "0x7fffffffffffffff"]);
  });

  it("answers an upstream 400 for a client's history request with 400, not a provider failure", async () => {
    const up = fakeFetch({
      [ALCHEMY]: () => new Response('{"error":"Invalid block parameter"}', { status: 400 }),
    });
    const res = await gateway({ fetch: up.fetch, networks: NETWORKS }).request(
      historyPath(ETH),
      post({ address: OWNER, cursor: "100" }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
  });
});
