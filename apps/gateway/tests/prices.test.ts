/**
 * `POST /v1/prices` against recorded provider answers. Every fixture under `fixtures/prices/` is a
 * real response (its `url` and `fetchedAt` inside): CoinGecko's keyless `api.coingecko.com` (the
 * Pro API the gateway calls serves the same documented shape) and DefiLlama's keyless
 * `coins.llama.fi`.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  nativeAssetId,
  parseWith,
  prices,
  pricesResponse,
  tokenAssetId,
} from "@qntx/wallet-engine/gateway/contract";
import type { PricesResponse } from "@qntx/wallet-engine/gateway/contract";

import { PRODUCTION_NETWORKS } from "../src/config/networks.ts";
import { GatewayHttpError } from "../src/middleware/errors.ts";
import { createForwarder } from "../src/providers/forward.ts";
import type { Forwarder } from "../src/providers/forward.ts";
import { NATIVE_COINS, TOKEN_PLATFORMS, priceTarget } from "../src/providers/prices-assets.ts";
import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import { normalizeQuote, plainDecimal, quotePrices } from "../src/providers/prices.ts";
import type { PriceDeps, PriceSource, RawQuote } from "../src/providers/prices.ts";
import type { RateLimiter } from "../src/types.ts";
import cgRateLimited from "./fixtures/prices/coingecko-rate-limited-429.json" with { type: "json" };
import cgEur from "./fixtures/prices/coingecko-simple-price-eur.json" with { type: "json" };
import cgSimple from "./fixtures/prices/coingecko-simple-price.json" with { type: "json" };
import cgEthereum from "./fixtures/prices/coingecko-token-price-ethereum.json" with { type: "json" };
import cgHyperevm from "./fixtures/prices/coingecko-token-price-hyperevm.json" with { type: "json" };
import cgLimit400 from "./fixtures/prices/coingecko-token-price-limit-400.json" with { type: "json" };
import cgSolana from "./fixtures/prices/coingecko-token-price-solana.json" with { type: "json" };
import cgUnknown from "./fixtures/prices/coingecko-token-price-unknown.json" with { type: "json" };
import llamaPercent from "./fixtures/prices/defillama-percentage-24h.json" with { type: "json" };
import llamaChains from "./fixtures/prices/defillama-prices-current-chains.json" with { type: "json" };
import llamaCurrent from "./fixtures/prices/defillama-prices-current.json" with { type: "json" };
import {
  fakeFetch,
  gateway,
  headers,
  memoryPriceCache,
  post,
  recordingLimiter,
  allowAll,
  countBefore,
} from "./helpers.ts";
import type { Upstream } from "./helpers.ts";

type Recorded = { readonly url: string; readonly status: number; readonly body: string };

const replay =
  (recorded: Recorded): Upstream =>
  () =>
    new Response(recorded.body, {
      status: recorded.status,
      headers: { "content-type": "application/json" },
    });

/** Just after the fixtures were recorded (their `last_updated_at` run 1794990626–1794990879). */
const NOW = 1_794_991_000_000;

const ETH = "eip155:1";
const BTC = "bip122:000000000019d6689c085ae165831e93";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const asset = (id: string | undefined): string => {
  if (id === undefined) {
    throw new TypeError("unpriceable fixture asset");
  }
  return id;
};
const ETH_NATIVE = asset(nativeAssetId(ETH));
const BASE_NATIVE = asset(nativeAssetId("eip155:8453"));
const BTC_NATIVE = asset(nativeAssetId(BTC));
const SOL_NATIVE = asset(nativeAssetId(SOL));
const HYPE_NATIVE = asset(nativeAssetId("eip155:999"));
const USDC_ETH = asset(tokenAssetId(ETH, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"));
const USDC_HYPEREVM = asset(
  tokenAssetId("eip155:999", "0xb88339CB7199b77E23DB6E890353E22632Ba630f"),
);
const USDC_SOL = asset(tokenAssetId(SOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
const DEAD = asset(tokenAssetId(ETH, "0x000000000000000000000000000000000000dEaD"));

const CG_SIMPLE = `${COINGECKO_API}/simple/price`;
const cgToken = (platform: string): string => `${COINGECKO_API}/simple/token_price/${platform}`;
const LLAMA_CURRENT = `${DEFILLAMA_API}/prices/current/`;
const LLAMA_PERCENT = `${DEFILLAMA_API}/percentage/`;

/** The number literal as it appears in the recorded body text — the oracle for exact decimals. */
const literal = (recorded: Recorded, key: string, field: string): string => {
  const at = recorded.body.indexOf(`"${key}"`);
  const match = new RegExp(`"${field}":(-?[0-9.e+-]+)`).exec(recorded.body.slice(at));
  if (at === -1 || match?.[1] === undefined) {
    throw new TypeError(`${key}.${field} not in the fixture`);
  }
  return match[1];
};

const request = (assets: ReadonlyArray<string>, currency = "usd") => post({ currency, assets });

const primary = (overrides: Record<string, Upstream> = {}) => ({
  [CG_SIMPLE]: replay(cgSimple),
  [cgToken("ethereum")]: replay(cgEthereum),
  [cgToken("hyperevm")]: replay(cgHyperevm),
  [cgToken("solana")]: replay(cgSolana),
  [LLAMA_CURRENT]: replay(llamaCurrent),
  [LLAMA_PERCENT]: replay(llamaPercent),
  ...overrides,
});

const app = (
  upstream: ReturnType<typeof fakeFetch>,
  extra: {
    readonly coingecko?: boolean;
    readonly cache?: ReturnType<typeof memoryPriceCache>;
  } = {},
  now: () => number = () => NOW,
) =>
  gateway({
    fetch: upstream.fetch,
    now,
    prices: {
      cache: extra.cache ?? memoryPriceCache(),
      ...(extra.coingecko === false ? {} : { coingecko: { apiKey: "cg-key" } }),
    },
  });

const body = async (res: Response): Promise<PricesResponse> => {
  const json: unknown = await res.json();
  const parsed = parseWith(pricesResponse, json);
  if (parsed === undefined) {
    throw new TypeError(`not a prices response: ${JSON.stringify(json)}`);
  }
  return parsed;
};

describe("POST /v1/prices request validation", () => {
  it.each([
    ["no assets", { currency: "usd", assets: [] }],
    ["an unknown currency", { currency: "xau", assets: [ETH_NATIVE] }],
    ["a duplicate asset", { currency: "usd", assets: [ETH_NATIVE, ETH_NATIVE] }],
    [
      "a checksummed ERC-20 id",
      { currency: "usd", assets: [`${ETH}/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`] },
    ],
    ["an NFT id", { currency: "usd", assets: [`${ETH}/erc721:0x${"ab".repeat(20)}/1`] }],
    [
      "101 assets",
      {
        currency: "usd",
        assets: Array.from(
          { length: 101 },
          (_v, i) => `${ETH}/erc20:0x${i.toString(16).padStart(40, "0")}`,
        ),
      },
    ],
  ])("rejects %s with 400 and never calls a provider", async (_name, payload) => {
    const upstream = fakeFetch({});
    const res = await app(upstream).request(prices.path, request(payload.assets, payload.currency));
    expect(res.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it("413s a body above 16 KiB", async () => {
    const upstream = fakeFetch({});
    const res = await app(upstream).request(
      prices.path,
      post({ currency: "usd", assets: ["x".repeat(17_000)] }),
    );
    expect(res.status).toBe(413);
  });

  it("charges one unit plus one per upstream call, and nothing more on a cache hit", async () => {
    const limiter = recordingLimiter();
    const upstream = fakeFetch({
      [cgToken("ethereum")]: () => Response.json({}),
      [LLAMA_CURRENT]: () => Response.json({ coins: {} }),
      [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
    });
    const assets = Array.from(
      { length: 100 },
      (_v, i) => `${ETH}/erc20:0x${i.toString(16).padStart(40, "0")}`,
    );
    const app = gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: limiter },
      prices: { cache: memoryPriceCache(), coingecko: { apiKey: "k" } },
    });
    const res = await app.request(prices.path, request(assets));
    expect(res.status).toBe(200);
    // The request, one CoinGecko platform call, DefiLlama's two calls.
    expect(limiter.deltas).toStrictEqual([1, 1, 2]);
    expect(upstream.calls).toHaveLength(3);

    const cached = await app.request(prices.path, request(assets));
    expect(cached.status).toBe(200);
    expect(limiter.deltas).toStrictEqual([1, 1, 2, 1]);
    expect(upstream.calls).toHaveLength(3);
  });
});

describe("POST /v1/prices fan-out accounting", () => {
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const PLATFORMS = [
    "eip155:1",
    "eip155:8453",
    "eip155:42161",
    "eip155:10",
    "eip155:137",
    "eip155:56",
    "eip155:999",
    "eip155:43114",
  ];
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  /** 100 distinct token ids over the nine token platforms; `seed` freshens them. */
  const spread = (seed: number): string[] =>
    Array.from({ length: 100 }, (_v, i) => {
      const n = seed * 100 + i;
      return i % 9 === 8
        ? `${SOL}/token:${B58[n % 58] ?? ""}${B58[Math.floor(n / 58) % 58] ?? ""}${"1".repeat(30)}`
        : `${PLATFORMS[i % 9] ?? ""}/erc20:0x${n.toString(16).padStart(40, "0")}`;
    });
  const answers = () =>
    fakeFetch({
      [COINGECKO_API]: () => Response.json({}),
      [DEFILLAMA_API]: () => Response.json({ coins: {} }),
    });

  it("charges one unit per upstream call a batch of unknown tokens fans out to", async () => {
    const limiter = recordingLimiter();
    const upstream = answers();
    const app = gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: limiter },
      prices: { cache: memoryPriceCache(), coingecko: { apiKey: "k" } },
    });
    for (const [seed, currency] of [
      [0, "usd"],
      [1, "usd"],
      [0, "eur"],
    ] as const) {
      const before = { units: limiter.deltas.length, calls: upstream.calls.length };
      // oxlint-disable-next-line eslint/no-await-in-loop -- requests in order on purpose
      const res = await app.request(prices.path, request(spread(seed), currency));
      expect(res.status).toBe(200);
      const units = limiter.deltas.slice(before.units).reduce((a, b) => a + b, 0);
      // The request's own unit plus one per upstream call it caused.
      expect(units).toBe(1 + upstream.calls.length - before.calls);
    }
    // 9 platform calls + 2 DefiLlama (usd), twice; 9 for eur, which DefiLlama does not serve.
    expect(upstream.calls).toHaveLength(31);
  });

  it("refuses a batch whose fan-out the limiter will not pay before any upstream call", async () => {
    // Every source's charge exceeds one unit, so no call can be paid: a refused
    // charge makes that source unavailable but never spends a call.
    const oneUnit: RateLimiter = {
      limit: async ({ delta = 1 }) => Promise.resolve({ success: delta <= 1 }),
    };
    const upstream = answers();
    const res = await gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: oneUnit, rpc: oneUnit, default: oneUnit },
      prices: { cache: memoryPriceCache(), coingecko: { apiKey: "k" } },
    }).request(prices.path, request(spread(0)));
    expect(res.status).toBe(429);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("POST /v1/prices refused charges", () => {
  const TOKEN = `${ETH}/erc20:0x${"1".repeat(40)}`;
  const LLAMA_KEY = `ethereum:0x${"1".repeat(40)}`;
  const upstreams = () =>
    fakeFetch({
      [COINGECKO_API]: (call) =>
        call.url.includes("token_price")
          ? // CoinGecko does not know the ERC-20: only DefiLlama can price it.
            Response.json({})
          : Response.json({
              ethereum: { usd: 3000, usd_24h_change: 1.5, last_updated_at: NOW / 1000 },
            }),
      [DEFILLAMA_API]: (call) =>
        call.url.includes("/percentage/")
          ? Response.json({ coins: { [LLAMA_KEY]: 2.5 } })
          : Response.json({
              coins: {
                [LLAMA_KEY]: { price: 1.25, timestamp: NOW / 1000, confidence: 0.999 },
              },
            }),
    });

  it("keeps an earlier source's paid answer when the next charge is refused", async () => {
    const upstream = upstreams();
    const cache = memoryPriceCache();
    // The request (1) and CoinGecko's two calls (2) fit; the DefiLlama charge does not.
    const limited = gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: countBefore(3) },
      prices: { cache, coingecko: { apiKey: "k" } },
    });
    const res = await limited.request(prices.path, request([ETH_NATIVE, TOKEN]));
    expect(res.status).toBe(200);
    const { prices: quoted, missing } = await body(res);
    expect(quoted.map((q) => q.asset)).toStrictEqual([ETH_NATIVE]);
    expect(missing).toStrictEqual([TOKEN]);
    expect(upstream.callsTo(COINGECKO_API)).toHaveLength(2);
    // The refused charge spent nothing: DefiLlama was never called.
    expect(upstream.callsTo(DEFILLAMA_API)).toHaveLength(0);
    // The paid answer is cached; the unpriced token is not cached as missing —
    // an uncharged source might know it.
    expect(cache.data.has(`usd/${ETH_NATIVE}`)).toBe(true);
    expect(cache.data.has(`usd/${TOKEN}`)).toBe(false);

    const open = app(upstream, { cache });
    const second = await open.request(prices.path, request([ETH_NATIVE, TOKEN]));
    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expect(secondBody.missing).toStrictEqual([]);
    // The cached coin was not refetched: no second CoinGecko coin call.
    expect(upstream.callsTo(CG_SIMPLE)).toHaveLength(1);
  });

  it("answers 429 when a refused charge is the only failure", async () => {
    const upstream = upstreams();
    const res = await gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: countBefore(1) },
      prices: { cache: memoryPriceCache(), coingecko: { apiKey: "k" } },
    }).request(prices.path, request([ETH_NATIVE]));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("POST /v1/prices from CoinGecko (recorded)", () => {
  it("prices natives and tokens as the provider's exact decimals, one call per platform", async () => {
    const upstream = fakeFetch(primary());
    const assets = [
      ETH_NATIVE,
      BASE_NATIVE,
      BTC_NATIVE,
      SOL_NATIVE,
      HYPE_NATIVE,
      USDC_ETH,
      USDC_HYPEREVM,
      USDC_SOL,
    ];
    const res = await app(upstream).request(prices.path, request(assets));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { prices: quoted, missing, currency } = await body(res);
    expect(currency).toBe("usd");
    expect(missing).toStrictEqual([]);
    expect(quoted.map((q) => q.asset)).toStrictEqual(assets);
    const byAsset = new Map(quoted.map((q) => [q.asset, q]));
    expect(byAsset.get(ETH_NATIVE)).toStrictEqual({
      asset: ETH_NATIVE,
      price: literal(cgSimple, "ethereum", "usd"),
      change24h: plainDecimal(Number(literal(cgSimple, "ethereum", "usd_24h_change")), 8),
      updatedAt: Number(literal(cgSimple, "ethereum", "last_updated_at")) * 1000,
    });
    // Base ETH is the same coin: one id, one price.
    expect(byAsset.get(BASE_NATIVE)?.price).toBe(byAsset.get(ETH_NATIVE)?.price);
    expect(byAsset.get(BTC_NATIVE)?.price).toBe(literal(cgSimple, "bitcoin", "usd"));
    expect(byAsset.get(USDC_SOL)?.price).toBe(
      literal(cgSolana, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "usd"),
    );
    expect(byAsset.get(USDC_HYPEREVM)?.price).toBe(
      literal(cgHyperevm, "0xb88339cb7199b77e23db6e890353e22632ba630f", "usd"),
    );

    expect(
      upstream
        .callsTo(COINGECKO_API)
        .map((c) => c.url)
        .toSorted(),
    ).toStrictEqual(
      [
        `${CG_SIMPLE}?ids=ethereum,bitcoin,solana,hyperliquid&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
        `${cgToken("ethereum")}?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
        `${cgToken("hyperevm")}?contract_addresses=0xb88339cb7199b77e23db6e890353e22632ba630f&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
        `${cgToken("solana")}?contract_addresses=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
      ].toSorted(),
    );
    for (const call of upstream.callsTo(COINGECKO_API)) {
      expect(call.headers).toStrictEqual({ "x-cg-pro-api-key": "cg-key" });
      expect(call.url).not.toContain("cg-key");
    }
    expect(upstream.callsTo(DEFILLAMA_API)).toHaveLength(0);
  });

  it("quotes the requested currency", async () => {
    const upstream = fakeFetch(primary({ [CG_SIMPLE]: replay(cgEur) }));
    const res = await app(upstream).request(prices.path, request([BTC_NATIVE, ETH_NATIVE], "eur"));
    const { prices: quoted, currency } = await body(res);
    expect(currency).toBe("eur");
    expect(quoted.map((q) => q.price)).toStrictEqual([
      literal(cgEur, "bitcoin", "eur"),
      literal(cgEur, "ethereum", "eur"),
    ]);
    expect(upstream.calls[0]?.url).toContain("vs_currencies=eur");
  });

  it("asks the fallback only for what the primary left unpriced", async () => {
    const upstream = fakeFetch(
      primary({
        [cgToken("ethereum")]: replay(cgUnknown),
        [LLAMA_CURRENT]: () => Response.json({ coins: {} }),
        [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
      }),
    );
    const res = await app(upstream).request(prices.path, request([BTC_NATIVE, DEAD]));
    const { prices: quoted, missing } = await body(res);
    expect(quoted.map((q) => q.asset)).toStrictEqual([BTC_NATIVE]);
    expect(missing).toStrictEqual([DEAD]);
    const llama = upstream.callsTo(DEFILLAMA_API).map((c) => c.url);
    expect(llama).toStrictEqual([
      `${LLAMA_CURRENT}ethereum:0x000000000000000000000000000000000000dead`,
      `${LLAMA_PERCENT}ethereum:0x000000000000000000000000000000000000dead?period=24h`,
    ]);
  });

  it("answers missing for assets no provider maps, without calling one", async () => {
    const upstream = fakeFetch({});
    const res = await app(upstream).request(
      prices.path,
      request([
        "eip155:11155111/slip44:60",
        "eip155:11155111/erc20:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
      ]),
    );
    await expect(body(res)).resolves.toStrictEqual({
      currency: "usd",
      prices: [],
      missing: [
        "eip155:11155111/slip44:60",
        "eip155:11155111/erc20:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
      ],
    });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("POST /v1/prices failover", () => {
  it.each([
    ["a 429", replay(cgRateLimited)],
    ["a 400 (the keyless batch limit)", replay(cgLimit400)],
    ["a malformed body", () => new Response("<html>")],
    ["an unexpected shape", () => Response.json({ ethereum: { usd: "1800" } })],
  ])("serves USD from DefiLlama when CoinGecko answers %s", async (_name, failure) => {
    const upstream = fakeFetch(primary({ [CG_SIMPLE]: failure }));
    const res = await app(upstream).request(prices.path, request([ETH_NATIVE, BTC_NATIVE]));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("defillama");
    const { prices: quoted, missing } = await body(res);
    expect(missing).toStrictEqual([]);
    expect(quoted).toStrictEqual([
      {
        asset: ETH_NATIVE,
        price: literal(llamaCurrent, "coingecko:ethereum", "price"),
        change24h: plainDecimal(
          Number(/"coingecko:ethereum":(-?[0-9.e+-]+)/.exec(llamaPercent.body)?.[1]),
          8,
        ),
        updatedAt: Number(literal(llamaCurrent, "coingecko:ethereum", "timestamp")) * 1000,
      },
      {
        asset: BTC_NATIVE,
        price: literal(llamaCurrent, "coingecko:bitcoin", "price"),
        change24h: plainDecimal(
          Number(/"coingecko:bitcoin":(-?[0-9.e+-]+)/.exec(llamaPercent.body)?.[1]),
          8,
        ),
        updatedAt: Number(literal(llamaCurrent, "coingecko:bitcoin", "timestamp")) * 1000,
      },
    ]);
    expect(upstream.callsTo(LLAMA_CURRENT)[0]?.url).toBe(
      `${LLAMA_CURRENT}coingecko:ethereum,coingecko:bitcoin`,
    );
  });

  it("maps every token chain to its DefiLlama key (recorded)", async () => {
    const upstream = fakeFetch({
      [LLAMA_CURRENT]: replay(llamaChains),
      [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
    });
    const tokens = [
      ["eip155:42161", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
      ["eip155:10", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
      ["eip155:137", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
      ["eip155:43114", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"],
      ["eip155:56", "0x55d398326f99059ff775485246999027b3197955"],
    ].map(([network = "", address = ""]) => asset(tokenAssetId(network, address)));
    const res = await app(upstream, { coingecko: false }).request(prices.path, request(tokens));
    const { prices: quoted, missing } = await body(res);
    expect(missing).toStrictEqual([]);
    expect(quoted.map((q) => q.change24h)).toStrictEqual(quoted.map(() => null));
    expect(quoted.every((q) => q.price.startsWith("0.999"))).toBe(true);
  });

  it("drops a DefiLlama price below its confidence floor", async () => {
    const upstream = fakeFetch({
      [LLAMA_CURRENT]: () =>
        Response.json({
          coins: { "coingecko:bitcoin": { price: 64000, timestamp: NOW / 1000, confidence: 0.5 } },
        }),
      [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
    });
    const res = await app(upstream, { coingecko: false }).request(
      prices.path,
      request([BTC_NATIVE]),
    );
    const dropped = await body(res);
    expect(dropped.missing).toStrictEqual([BTC_NATIVE]);
  });

  it("serves the fallback alone when no CoinGecko key is configured", async () => {
    const upstream = fakeFetch(primary());
    const res = await app(upstream, { coingecko: false }).request(
      prices.path,
      request([BTC_NATIVE]),
    );
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("defillama");
    expect(upstream.callsTo(COINGECKO_API)).toHaveLength(0);
  });

  it("503s when every provider fails and nothing could be priced", async () => {
    const upstream = fakeFetch(
      primary({
        [CG_SIMPLE]: replay(cgRateLimited),
        [LLAMA_CURRENT]: () => new Response("down", { status: 502 }),
      }),
    );
    const res = await app(upstream).request(prices.path, request([BTC_NATIVE]));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("503s a non-USD request when the primary fails — the fallback quotes USD only", async () => {
    const upstream = fakeFetch(primary({ [CG_SIMPLE]: replay(cgRateLimited) }));
    const res = await app(upstream).request(prices.path, request([BTC_NATIVE], "eur"));
    expect(res.status).toBe(503);
    expect(upstream.callsTo(DEFILLAMA_API)).toHaveLength(0);
  });

  it("answers what one provider priced when another failed", async () => {
    const upstream = fakeFetch(
      primary({
        [cgToken("ethereum")]: replay(cgUnknown),
        [LLAMA_CURRENT]: () => new Response("down", { status: 502 }),
      }),
    );
    const res = await app(upstream).request(prices.path, request([BTC_NATIVE, DEAD]));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    const { prices: quoted, missing } = await body(res);
    expect(quoted.map((q) => q.asset)).toStrictEqual([BTC_NATIVE]);
    expect(missing).toStrictEqual([DEAD]);
  });
});

describe("POST /v1/prices attempt cancellation", () => {
  it("cancels a failed attempt's other in-flight calls", async () => {
    let solanaSignal: AbortSignal | undefined;
    let onAbort: ((signal: AbortSignal) => void) | undefined;
    const cancelled = new Promise<AbortSignal>((resolve) => {
      onAbort = resolve;
    });
    const upstream = fakeFetch(
      primary({
        [cgToken("ethereum")]: () => new Response("batch limit", { status: 400 }),
        [cgToken("solana")]: async (_call, signal) => {
          solanaSignal = signal;
          return new Promise<Response>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                resolve(Response.json({}));
                onAbort?.(signal);
              },
              { once: true },
            );
          });
        },
      }),
    );
    const res = await app(upstream).request(prices.path, request([USDC_ETH, USDC_SOL]));
    // CoinGecko's two platform calls ran together; ethereum's 400 failed the attempt, so the
    // still-open solana call is cancelled before the answer fails over to DefiLlama.
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("defillama");
    expect(solanaSignal?.aborted).toBe(true);
    const signal = await cancelled;
    expect(signal.aborted).toBe(true);
  });

  it("does not cancel a successful attempt's calls", async () => {
    const signals: AbortSignal[] = [];
    const seen =
      (handler: Upstream): Upstream =>
      async (call, signal) => {
        signals.push(signal);
        return handler(call, signal);
      };
    const upstream = fakeFetch(
      primary({
        [cgToken("ethereum")]: seen(replay(cgEthereum)),
        [cgToken("solana")]: seen(replay(cgSolana)),
      }),
    );
    const res = await app(upstream).request(prices.path, request([USDC_ETH, USDC_SOL]));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal.aborted).toBe(false);
    }
  });
});

describe("POST /v1/prices cache", () => {
  it("serves a cached asset for 30 s, then asks the provider again", async () => {
    const cache = memoryPriceCache();
    const upstream = fakeFetch(primary());
    let now = NOW;
    const served = app(upstream, { cache }, () => now);
    await served.request(prices.path, request([BTC_NATIVE]));
    expect(cache.ttls).toStrictEqual([30]);
    expect([...cache.data.keys()]).toStrictEqual([`usd/${BTC_NATIVE}`]);

    now += 29_999;
    const cached = await served.request(prices.path, request([BTC_NATIVE]));
    const cachedBody = await body(cached);
    expect(cachedBody.prices[0]?.price).toBe(literal(cgSimple, "bitcoin", "usd"));
    expect(cached.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    expect(upstream.calls).toHaveLength(1);

    now += 1;
    await served.request(prices.path, request([BTC_NATIVE]));
    expect(upstream.calls).toHaveLength(2);
  });

  it("caches per currency and asset, never per client", async () => {
    const cache = memoryPriceCache();
    const upstream = fakeFetch(primary({ [CG_SIMPLE]: replay(cgEur) }));
    const served = app(upstream, { cache });
    await served.request(prices.path, {
      ...request([BTC_NATIVE], "eur"),
      headers: headers({ "content-type": "application/json", "x-client-id": "f".repeat(32) }),
    });
    await served.request(prices.path, request([BTC_NATIVE], "eur"));
    expect(upstream.calls).toHaveLength(1);
    expect([...cache.data.keys()]).toStrictEqual([`eur/${BTC_NATIVE}`]);
  });

  it("caches an unpriced asset only when every provider answered", async () => {
    const cache = memoryPriceCache();
    const answered = fakeFetch(
      primary({
        [cgToken("ethereum")]: replay(cgUnknown),
        [LLAMA_CURRENT]: () => Response.json({ coins: {} }),
        [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
      }),
    );
    await app(answered, { cache }).request(prices.path, request([DEAD]));
    const storedDead = cache.data.get(`usd/${DEAD}`);
    expect(storedDead).toBeDefined();
    expect(JSON.parse(String(storedDead))).toMatchObject({ quote: null });
    await app(answered, { cache }).request(prices.path, request([DEAD]));
    expect(answered.calls).toHaveLength(3);

    const partial = memoryPriceCache();
    const failing = fakeFetch(primary({ [cgToken("ethereum")]: replay(cgRateLimited) }));
    await app(failing, { cache: partial }).request(prices.path, request([DEAD, BTC_NATIVE]));
    expect([...partial.data.keys()]).toStrictEqual([`usd/${BTC_NATIVE}`]);
  });

  it("treats a failing or corrupt cache as a miss and still answers", async () => {
    const lines: string[] = [];
    const upstream = fakeFetch(primary());
    const broken = {
      get: async () => Promise.reject(new Error("cache down")),
      put: async () => Promise.reject(new Error("cache down")),
    };
    const res = await gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      log: (line) => lines.push(line),
      prices: { cache: broken, coingecko: { apiKey: "k" } },
    }).request(prices.path, request([BTC_NATIVE]));
    expect(res.status).toBe(200);
    expect(lines.filter((l) => l.includes("price-cache-failure"))).toStrictEqual([
      JSON.stringify({ event: "price-cache-failure", op: "get" }),
      JSON.stringify({ event: "price-cache-failure", op: "put" }),
    ]);

    const corrupt = memoryPriceCache();
    corrupt.data.set(
      `usd/${BTC_NATIVE}`,
      JSON.stringify({
        expiresAt: NOW + 1,
        provider: "x",
        quote: { asset: BTC_NATIVE, price: "1e9", change24h: null, updatedAt: NOW },
      }),
    );
    const fresh = fakeFetch(primary());
    const again = await app(fresh, { cache: corrupt }).request(prices.path, request([BTC_NATIVE]));
    const againBody = await body(again);
    expect(againBody.prices[0]?.price).toBe(literal(cgSimple, "bitcoin", "usd"));
    expect(fresh.calls).toHaveLength(1);
  });
});

describe("price bounds", () => {
  const raw = (price: number, change24h?: number, updatedAtSeconds = NOW / 1000) => ({
    price,
    change24h,
    updatedAtSeconds,
  });

  it.each([
    ["zero", raw(0)],
    ["negative", raw(-1)],
    ["at 10^12", raw(1e12)],
    ["infinite", raw(Number.POSITIVE_INFINITY)],
    ["NaN", raw(Number.NaN)],
    ["below 10^-18", raw(1e-19)],
    ["updated beyond the clock-skew window", raw(1, undefined, (NOW + 5 * 60_000 + 1000) / 1000)],
    ["updated over a day ago", raw(1, undefined, (NOW - 86_400_000 - 1000) / 1000)],
    ["timestamped zero", raw(1, undefined, 0)],
  ])("rejects a price that is %s", (_name, quote) => {
    expect(normalizeQuote(BTC_NATIVE, quote, NOW)).toBeUndefined();
  });

  it.each([
    [999_999_999_999.5, "999999999999.5"],
    [1e-18, "0.000000000000000001"],
    [1.23456789e-12, "0.000000000001234567"],
    [2.5e-19 + 1e-18, "0.000000000000000001"],
  ])("keeps %d as %s (truncated to 18 decimals)", (value, expected) => {
    expect(normalizeQuote(BTC_NATIVE, raw(value), NOW)?.price).toBe(expected);
  });

  it.each([
    [-100.5, null],
    [1_000_000, null],
    [-100, "-100"],
    [-1e-9, "0"],
    [12.3456789012, "12.3456789"],
  ])("bounds a 24 h change of %d to %s", (change, expected) => {
    expect(normalizeQuote(BTC_NATIVE, raw(1, change), NOW)?.change24h).toBe(expected);
  });

  it("spells every float exactly as its shortest round-trip form", () => {
    const samples = [
      64683.08229625645,
      0.9995131084178598,
      1.5e-7,
      7.150054620000001,
      1e21,
      123_456_789.000001,
      5e-324,
      0.1,
      1 / 3,
      -0.0171935087437923,
      -3.4e-5,
    ];
    for (const value of samples) {
      const spelled = plainDecimal(value, 400);
      expect(spelled).toMatch(/^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/);
      expect(Number(spelled)).toBe(value);
    }
    expect(plainDecimal(1.5e-7, 400)).toBe("0.00000015");
    expect(plainDecimal(1e21, 0)).toBe("1000000000000000000000");
    expect(plainDecimal(-0.000000001, 8)).toBe("0");
  });
});

describe("POST /v1/prices provider edge cases", () => {
  it("answers a null 24 h change when CoinGecko omits the field", async () => {
    const upstream = fakeFetch(
      primary({
        [CG_SIMPLE]: () =>
          Response.json({ bitcoin: { usd: 64000.5, last_updated_at: NOW / 1000 } }),
      }),
    );
    const res = await app(upstream).request(prices.path, request([BTC_NATIVE]));
    expect(res.status).toBe(200);
    const { prices: quoted } = await body(res);
    expect(quoted).toStrictEqual([
      { asset: BTC_NATIVE, price: "64000.5", change24h: null, updatedAt: NOW },
    ]);
  });

  it("drops a DefiLlama entry that carries no confidence score", async () => {
    const upstream = fakeFetch({
      [LLAMA_CURRENT]: () =>
        Response.json({
          coins: { "coingecko:bitcoin": { price: 64000.5, timestamp: NOW / 1000 } },
        }),
      [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
    });
    const res = await app(upstream, { coingecko: false }).request(
      prices.path,
      request([BTC_NATIVE]),
    );
    expect(res.status).toBe(200);
    const { missing } = await body(res);
    expect(missing).toStrictEqual([BTC_NATIVE]);
  });

  it("503s when DefiLlama answers a body its schema cannot read", async () => {
    const upstream = fakeFetch({
      [LLAMA_CURRENT]: () => Response.json({ unexpected: true }),
      [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
    });
    const res = await app(upstream, { coingecko: false }).request(
      prices.path,
      request([BTC_NATIVE]),
    );
    expect(res.status).toBe(503);
  });
});

describe("quotePrices", () => {
  const deps = (
    sources: ReadonlyArray<PriceSource>,
    forwarder: Forwarder = createForwarder(fakeFetch({}).fetch, () => {}),
  ): PriceDeps => ({
    forwarder,
    cache: memoryPriceCache(),
    sources,
    now: () => NOW,
    log: () => {},
  });

  const fakeSource = (value: ReadonlyMap<string, RawQuote>): PriceSource => ({
    provider: { id: "fake", url: "https://fake.test" },
    serves: () => true,
    calls: () => 1,
    quote: async () => {
      await Promise.resolve();
      return value;
    },
  });

  /** A `charge` that pays for `budget` units, then throws the limiter's 429 refusal. */
  const chargeUpTo = (budget: number): ((units: number) => Promise<void>) => {
    const limiter = countBefore(budget);
    return async (units) => {
      const { success } = await limiter.limit({ key: "charge", delta: units });
      if (!success) {
        throw new GatewayHttpError(429, "rate-limited", 10);
      }
    };
  };

  it("ignores quotes for assets it never asked and prices that fail normalization", async () => {
    const source = fakeSource(
      new Map([
        [ETH_NATIVE, { price: 1810.44, change24h: undefined, updatedAtSeconds: NOW / 1000 }],
        // Rejected by normalizeQuote: a zero price is no price.
        [BTC_NATIVE, { price: 0, change24h: undefined, updatedAtSeconds: NOW / 1000 }],
        // A quote for an asset the request never named is dropped, not answered.
        [USDC_ETH, { price: 1, change24h: undefined, updatedAtSeconds: NOW / 1000 }],
      ]),
    );
    const { response, providers } = await quotePrices(
      deps([source]),
      { currency: "usd", assets: [ETH_NATIVE, BTC_NATIVE] },
      async () => {},
    );
    expect(response.prices.map((q) => q.asset)).toStrictEqual([ETH_NATIVE]);
    expect(response.missing).toStrictEqual([BTC_NATIVE]);
    expect(providers).toStrictEqual(["fake"]);
  });

  it("rethrows a forwarder failure that is not the request's own answer", async () => {
    const forwarder: Forwarder = {
      run: async () => Promise.reject(new TypeError("crash")),
    };
    const source = fakeSource(new Map());
    await expect(
      quotePrices(
        deps([source], forwarder),
        { currency: "usd", assets: [ETH_NATIVE] },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("answers what earlier sources priced when a later charge is refused", async () => {
    const quote = { price: 1810.44, change24h: undefined, updatedAtSeconds: NOW / 1000 };
    const never: PriceSource = {
      provider: { id: "never", url: "https://never.test" },
      serves: () => true,
      calls: () => 1,
      quote: async () => Promise.reject(new TypeError("must not be called")),
    };
    const { response } = await quotePrices(
      deps([fakeSource(new Map([[ETH_NATIVE, quote]])), never]),
      { currency: "usd", assets: [ETH_NATIVE, BTC_NATIVE] },
      chargeUpTo(1),
    );
    expect(response.prices.map((q) => q.asset)).toStrictEqual([ETH_NATIVE]);
    expect(response.missing).toStrictEqual([BTC_NATIVE]);
  });

  it("rethrows the refused charge when nothing could be priced", async () => {
    const quote = { price: 1810.44, change24h: undefined, updatedAtSeconds: NOW / 1000 };
    await expect(
      quotePrices(
        deps([fakeSource(new Map([[ETH_NATIVE, quote]]))]),
        { currency: "usd", assets: [ETH_NATIVE] },
        chargeUpTo(0),
      ),
    ).rejects.toMatchObject({ status: 429, code: "rate-limited" });
  });

  it("answers 503 over 429 when a provider failed and a charge was refused", async () => {
    const quote = { price: 1810.44, change24h: undefined, updatedAtSeconds: NOW / 1000 };
    const forwarder: Forwarder = {
      run: async () => Promise.reject(new GatewayHttpError(503, "unavailable", 30)),
    };
    const dead = { ...fakeSource(new Map()), provider: { id: "dead", url: "https://dead.test" } };
    await expect(
      quotePrices(
        deps([dead, fakeSource(new Map([[BTC_NATIVE, quote]]))], forwarder),
        { currency: "usd", assets: [ETH_NATIVE, BTC_NATIVE] },
        chargeUpTo(1),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("prices-assets tables", () => {
  it("maps every production EVM network's tokens to a provider platform", () => {
    for (const id of PRODUCTION_NETWORKS.map((n) => n.id).filter((id) =>
      id.startsWith("eip155:"),
    )) {
      expect(TOKEN_PLATFORMS[id]).toBeDefined();
    }
  });

  it("prices exactly the native assets the registry yields for the served networks", () => {
    const natives = new Set(
      PRODUCTION_NETWORKS.map(({ id }) => nativeAssetId(id)).filter(
        (id): id is string => id !== undefined,
      ),
    );
    expect(new Set(Object.keys(NATIVE_COINS))).toStrictEqual(natives);
  });

  it("leaves Plasma's native coin unpriced — no SLIP-44 coin type — while its ERC-20s price", () => {
    expect(priceTarget("eip155:9745/slip44:60")).toBeUndefined();
    const usdc = priceTarget("eip155:9745/erc20:0x2d661c89d812261039af9764eceaaee884f5f67f");
    expect(usdc).toStrictEqual({
      coingecko: {
        kind: "token",
        platform: "plasma",
        address: "0x2d661c89d812261039af9764eceaaee884f5f67f",
      },
      defillama: "plasma:0x2d661c89d812261039af9764eceaaee884f5f67f",
    });
  });
});
