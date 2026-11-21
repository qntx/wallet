import { describe, expect, it, vi } from "vite-plus/test";

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

import { UPSTREAM_TIMEOUT_MS } from "../src/providers/forward.ts";
import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import type { GatewayNetwork } from "../src/types.ts";
import {
  SEPOLIA,
  SIGNET,
  allowAll,
  call,
  fakeFetch,
  gateway,
  headers,
  post,
  recordingLimiter,
  rpcOk,
} from "./helpers.ts";
import type { Upstream, UpstreamCall } from "./helpers.ts";

const ETH = "eip155:1";
const NILE = "tron:3448148188";
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
  {
    id: NILE,
    providers: [
      { id: "trongrid", url: "https://a.test/tron" },
      { id: "b", url: "https://b.test/tron" },
    ],
  },
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
    // Not eth_chainId: the probe uses it, and the timeout tests tell the two bodies apart.
    request: [rpcPath(SEPOLIA), post(call("eth_blockNumber"))],
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
  "POST /v1/tron/:caip2/*": {
    request: [`/v1/tron/${NILE}/wallet/getchainparameters`, post({})],
    upstreams: ["https://a.test/tron", "https://b.test/tron"],
  },
};

/** A cache that never hits, so every request reaches the price upstreams. */
const noCache = {
  get: async () => Promise.resolve(undefined),
  put: async () => Promise.resolve(),
};

const appWith = (answer: Upstream, now: () => number = Date.now) => {
  const forwarded = Object.values(ROUTES).filter((route): route is Forwarded => route !== null);
  const up = fakeFetch(
    Object.fromEntries(forwarded.flatMap((route) => route.upstreams.map((url) => [url, answer]))),
  );
  const app = gateway({
    fetch: up.fetch,
    networks: NETWORKS,
    now,
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

/**
 * A refusal the provider announces before doing any work. It parks the account briefly but is never
 * an outage — the provider is reachable by definition, and a broadcast may safely fail over.
 */
const THROTTLED: ReadonlyArray<readonly [string, Upstream]> = [
  ["status 429", () => new Response("throttled", { status: 429 })],
  [
    "status 429 with a Retry-After",
    () => new Response("throttled", { status: 429, headers: { "retry-after": "3" } }),
  ],
];

/** The cheap reachability request the forwarder sends after an attempt times out. */
const isProbe = (call: UpstreamCall): boolean =>
  call.url.endsWith("/blocks/tip/height") ||
  call.url.endsWith("/ping") ||
  call.url.endsWith("/wallet/getnowblock") ||
  call.body.includes('"method":"eth_chainId"') ||
  call.body.includes('"method":"getHealth"');

/** Hangs every real call; probe-shaped calls get the given answer instead. */
const hangBut =
  (probe: Upstream): Upstream =>
  // oxlint-disable-next-line typescript/promise-function-async -- hangs by design
  (call, signal) =>
    isProbe(call) ? probe(call, signal) : new Promise<Response>(() => {});

/** Failures only the provider owns: these, and only these, open its breaker. */
const OUTAGES: ReadonlyArray<readonly [string, Upstream]> = [
  ...[500, 503].map((status): readonly [string, Upstream] => [
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

/**
 * Routes whose first provider declares a probe — the only ones where a timeout can count when the
 * probe also fails. Providers without a probe (0x, Jupiter, Across) never count a timeout.
 */
const PROBED = new Set([
  "POST /v1/rpc/:caip2",
  "POST /v1/history/:caip2",
  "GET /v1/esplora/:caip2/*",
  "POST /v1/esplora/:caip2/*",
  "POST /v1/tron/:caip2/*",
  `POST ${prices.path}`,
]);

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

    it.each(THROTTLED)(
      "cools the account and keeps its breaker closed after %s",
      async (_label, answer) => {
        let clock = 0;
        const { app, up } = appWith(answer, () => clock);
        for (let i = 0; i < 6; i += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- consecutive refusals on purpose
          await app.request(...request);
        }
        const before = up.callsTo(watched).length;
        await app.request(...request);
        // The parked account is skipped without a call, whatever the breaker says.
        expect(up.callsTo(watched)).toHaveLength(before);
        clock += 31_000;
        await app.request(...request);
        // Cool-down expired and the breaker never opened: the provider is tried again.
        expect(up.callsTo(watched).length).toBeGreaterThan(before);
      },
    );

    it("keeps its breaker closed after six attempt timeouts the probe survives", async () => {
      vi.useFakeTimers();
      try {
        const { app, up } = appWith(hangBut(() => new Response("{}")));
        // Just past the walk's timeouts; under the breaker's half-open window, so a call after
        // the last request proves the breaker stayed closed, not that a trial ran.
        const once = async () => {
          const pending = app.request(...request);
          await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS * upstreams.length + 5000);
          await pending;
        };
        // Every request must reach the provider: one flat request is the breaker skipping it —
        // a count check only at the end cannot tell that apart from a half-open trial.
        let count = 0;
        for (let i = 0; i < 7; i += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- consecutive timeouts on purpose
          await once();
          const current = up.callsTo(watched).length;
          expect(current).toBeGreaterThan(count);
          count = current;
        }
      } finally {
        vi.useRealTimers();
      }
    });

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

describe.each(forwardedRoutes.filter(([key]) => PROBED.has(key)))(
  "probed route %s",
  (_key, { request, upstreams }) => {
    const [watched] = upstreams;

    it("opens its breaker after five timeouts whose probe also fails", async () => {
      vi.useFakeTimers();
      try {
        const { app, up } = appWith(hangBut(() => new Response("down", { status: 500 })));
        const once = async () => {
          const pending = app.request(...request);
          await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS * upstreams.length + 5000);
          await pending;
        };
        for (let i = 0; i < 5; i += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- consecutive failures on purpose
          await once();
        }
        const before = up.callsTo(watched).length;
        await once();
        expect(up.callsTo(watched)).toHaveLength(before);
      } finally {
        vi.useRealTimers();
      }
    });
  },
);

describe("account cool-down", () => {
  it("skips every network's providers of a throttled account until the cool-down expires", async () => {
    let clock = 0;
    const up = fakeFetch({
      "https://a.test/btc": () => new Response("throttled", { status: 429 }),
      "https://b.test/btc": () => new Response("{}"),
      "https://a.test/evm": () => rpcOk("0xaa36a7"),
      "https://b.test/evm": () => rpcOk("0xaa36a7"),
    });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, now: () => clock });
    const btc = await app.request(`/v1/esplora/${SIGNET}/fee-estimates`, { headers: headers() });
    expect(btc.status).toBe(200);
    expect(up.callsTo("https://a.test/btc")).toHaveLength(1);
    // The same account is parked on every network, not only the one that throttled it.
    const evm = await app.request(rpcPath(SEPOLIA), post(call("eth_blockNumber")));
    expect(evm.status).toBe(200);
    expect(up.callsTo("https://a.test/evm")).toHaveLength(0);
    clock += 31_000;
    await app.request(rpcPath(SEPOLIA), post(call("eth_blockNumber")));
    expect(up.callsTo("https://a.test/evm")).toHaveLength(1);
  });

  it("answers the smallest announced wait when every provider is cooling", async () => {
    let clock = 0;
    const up = fakeFetch({
      "https://a.test/btc": () =>
        new Response("throttled", { status: 429, headers: { "retry-after": "7" } }),
      "https://b.test/btc": () =>
        new Response("throttled", { status: 429, headers: { "retry-after": "3" } }),
    });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, now: () => clock });
    const first = await app.request(`/v1/esplora/${SIGNET}/fee-estimates`, {
      headers: headers(),
    });
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("3");
    clock += 1000;
    const parked = await app.request(`/v1/esplora/${SIGNET}/fee-estimates`, {
      headers: headers(),
    });
    expect(parked.status).toBe(503);
    expect(parked.headers.get("retry-after")).toBe("2");
  });
});

describe("upstream cost metering", () => {
  /** The billing account each upstream URL prefix belongs to. */
  const ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
    ["https://a.test/tron", "trongrid"],
    ["https://a.test", "a"],
    ["https://b.test", "b"],
    [ALCHEMY, "alchemy"],
    ["https://api.0x.org", "0x"],
    ["https://api.jup.ag", "jupiter"],
    ["https://app.across.to", "across"],
    [COINGECKO_API, "coingecko"],
    [DEFILLAMA_API, "defillama"],
  ];
  const accountOf = (url: string): string => {
    const found = ACCOUNTS.find(([prefix]) => url.startsWith(prefix));
    if (found === undefined) {
      throw new Error(`no account for ${url}`);
    }
    return found[1];
  };

  it.each(forwardedRoutes)("meters every upstream call of %s", async (_key, { request }) => {
    const { up } = appWith(() => new Response("{}"));
    const share = recordingLimiter();
    const metered = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share },
      zeroEx: { apiKey: "k" },
      prices: { cache: noCache, coingecko: { apiKey: "k" } },
    });
    await metered.request(...request);
    // One share charge per upstream call, keyed by that call's account and the client's prefix.
    const expected = up.calls.map((c) => `${accountOf(c.url)}:unknown`).toSorted();
    expect(share.keys.toSorted()).toStrictEqual(expected);
    expect(share.deltas.every((delta) => delta >= 1)).toBe(true);
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
