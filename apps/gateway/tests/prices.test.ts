/**
 * `POST /v1/prices/:family` against recorded provider answers. Every fixture under
 * `fixtures/prices/` is a real response (its `url` and `fetchedAt` inside): CoinGecko's keyless
 * `api.coingecko.com` (the Pro API the gateway calls serves the same documented shape) and
 * DefiLlama's keyless `coins.llama.fi`.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  nativeAssetId,
  parseWith,
  priceAssetFamily,
  pricesPath,
  pricesResponse,
  tokenAssetId,
} from "@qntx/wallet-engine/gateway/contract";
import type { PricesResponse } from "@qntx/wallet-engine/gateway/contract";

import { PRODUCTION_NETWORKS } from "../src/config/networks.ts";
import type { RateLimiter } from "../src/limits.ts";
import { GatewayHttpError } from "../src/middleware/errors.ts";
import type { Forwarder, Meter } from "../src/providers/forward.ts";
import { NATIVE_COINS, TOKEN_PLATFORMS, priceTarget } from "../src/providers/prices-assets.ts";
import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import { normalizeQuote, plainDecimal, quotePrices } from "../src/providers/prices.ts";
import type { PriceDeps, PriceSource, RawQuote } from "../src/providers/prices.ts";
import cgRateLimited from "./fixtures/prices/coingecko-rate-limited-429.json" with { type: "json" };
import cgEur from "./fixtures/prices/coingecko-simple-price-eur.json" with { type: "json" };
import cgTron from "./fixtures/prices/coingecko-simple-price-tron.json" with { type: "json" };
import cgSimple from "./fixtures/prices/coingecko-simple-price.json" with { type: "json" };
import cgEthereum from "./fixtures/prices/coingecko-token-price-ethereum.json" with { type: "json" };
import cgHyperevm from "./fixtures/prices/coingecko-token-price-hyperevm.json" with { type: "json" };
import cgLimit400 from "./fixtures/prices/coingecko-token-price-limit-400.json" with { type: "json" };
import cgSolana from "./fixtures/prices/coingecko-token-price-solana.json" with { type: "json" };
import cgTronToken from "./fixtures/prices/coingecko-token-price-tron.json" with { type: "json" };
import cgUnknown from "./fixtures/prices/coingecko-token-price-unknown.json" with { type: "json" };
import llamaTronPercent from "./fixtures/prices/defillama-percentage-24h-tron.json" with { type: "json" };
import llamaPercent from "./fixtures/prices/defillama-percentage-24h.json" with { type: "json" };
import llamaChains from "./fixtures/prices/defillama-prices-current-chains.json" with { type: "json" };
import llamaTron from "./fixtures/prices/defillama-prices-current-tron.json" with { type: "json" };
import llamaCurrent from "./fixtures/prices/defillama-prices-current.json" with { type: "json" };
import {
  fakeFetch,
  gateway,
  headers,
  memoryEdgeCache,
  post,
  recordingLimiter,
  allowAll,
  countBefore,
  denyAll,
  testProvider,
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
const TRX_NATIVE = asset(nativeAssetId("tron:728126428"));
const USDT_TRON = asset(tokenAssetId("tron:728126428", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"));
/** Just after the TRON fixtures were recorded (their `last_updated_at` run 1795256847–1795256852). */
const TRON_NOW = 1_795_257_000_000;
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

const init = (assets: ReadonlyArray<string>, currency = "usd") => post({ currency, assets });

/**
 * `[path, init]` for a family-homogeneous asset set — under `POST /v1/prices/:family` a body may
 * name only the route family's assets, so a cross-family set here is a test bug, not a request.
 */
const request = (assets: ReadonlyArray<string>, currency = "usd") => {
  const families = new Set(assets.map(priceAssetFamily));
  const family = families.size === 0 ? "evm" : [...families][0];
  if (families.size > 1 || family === undefined) {
    throw new TypeError(`cross-family or unmappable asset set: ${assets.join(",")}`);
  }
  return [pricesPath(family), init(assets, currency)] as const;
};

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
    readonly cache?: ReturnType<typeof memoryEdgeCache>;
  } = {},
  now: () => number = () => NOW,
) =>
  gateway({
    fetch: upstream.fetch,
    now,
    prices: {
      cache: extra.cache ?? memoryEdgeCache(),
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

describe("POST /v1/prices/:family request validation", () => {
  it.each<[string, string]>([
    ["evm", ETH_NATIVE],
    ["solana", SOL_NATIVE],
    ["bitcoin", BTC_NATIVE],
    ["tron", TRX_NATIVE],
  ])("serves /v1/prices/%s", async (family, native) => {
    const upstream = fakeFetch(primary());
    const res = await app(upstream).request(pricesPath(family as "evm"), init([native]));
    expect(res.status).toBe(200);
  });

  it("404s an unknown family and never calls a provider", async () => {
    const upstream = fakeFetch(primary());
    const res = await app(upstream).request("/v1/prices/cosmos", init([ETH_NATIVE]));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toStrictEqual({ error: "not-found" });
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    ["an evm asset on the solana route", "solana", [ETH_NATIVE]],
    ["a bitcoin asset on the evm route", "evm", [BTC_NATIVE]],
    ["one foreign asset among family ones", "evm", [ETH_NATIVE, TRX_NATIVE]],
  ])("400s %s", async (_name, family, assets) => {
    const upstream = fakeFetch(primary());
    const res = await app(upstream).request(pricesPath(family as "evm"), init(assets));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    expect(upstream.calls).toHaveLength(0);
  });

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
    const res = await app(upstream).request(...request(payload.assets, payload.currency));
    expect(res.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it("413s a body above 16 KiB", async () => {
    const upstream = fakeFetch({});
    const res = await app(upstream).request(
      pricesPath("evm"),
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
    const share = recordingLimiter();
    const app = gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: limiter, share },
      prices: { cache: memoryEdgeCache(), coingecko: { apiKey: "k" } },
    });
    const res = await app.request(...request(assets));
    expect(res.status).toBe(200);
    // The request's own unit, then one CoinGecko platform call and DefiLlama's two.
    expect(limiter.deltas).toStrictEqual([1]);
    expect(share.deltas).toStrictEqual([1, 1, 1]);
    expect(upstream.calls).toHaveLength(3);

    const cached = await app.request(...request(assets));
    expect(cached.status).toBe(200);
    expect(limiter.deltas).toStrictEqual([1, 1]);
    expect(share.deltas).toStrictEqual([1, 1, 1]);
    expect(upstream.calls).toHaveLength(3);
  });
});

describe("POST /v1/prices/:family fan-out accounting", () => {
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
  /**
   * 100 distinct token ids over the nine token platforms, per family — `POST /v1/prices/:family`
   * names one family's assets, so the batch is sent as an evm request plus a solana one; `seed`
   * freshens them.
   */
  const evmSpread = (seed: number): string[] =>
    Array.from({ length: 89 }, (_v, i) => {
      const n = seed * 100 + i * 9;
      return `${PLATFORMS[i % 8] ?? ""}/erc20:0x${n.toString(16).padStart(40, "0")}`;
    });
  const solSpread = (seed: number): string[] =>
    Array.from({ length: 11 }, (_v, i) => {
      const n = seed * 100 + i;
      return `${SOL}/token:${B58[n % 58] ?? ""}${B58[Math.floor(n / 58) % 58] ?? ""}${"1".repeat(30)}`;
    });
  const answers = () =>
    fakeFetch({
      [COINGECKO_API]: () => Response.json({}),
      [DEFILLAMA_API]: () => Response.json({ coins: {} }),
    });

  it("bills one unit per upstream call a batch of unknown tokens fans out to", async () => {
    const limiter = recordingLimiter();
    const upstream = answers();
    const app = gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: limiter },
      prices: { cache: memoryEdgeCache(), coingecko: { apiKey: "k" } },
    });
    for (const [seed, currency] of [
      [0, "usd"],
      [1, "usd"],
      [0, "eur"],
    ] as const) {
      const before = { units: limiter.deltas.length, calls: upstream.calls.length };
      for (const assets of [evmSpread(seed), solSpread(seed)]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- requests in order on purpose
        const res = await app.request(...request(assets, currency));
        expect(res.status).toBe(200);
      }
      const units = limiter.deltas.slice(before.units).reduce((a, b) => a + b, 0);
      // One share unit per upstream call the request's cache misses fanned out to.
      expect(units).toBe(upstream.calls.length - before.calls);
    }
    // Per request: its platform calls + 2 DefiLlama (usd); eur, which DefiLlama does not serve.
    expect(upstream.calls).toHaveLength(35);
  });

  it("refuses a batch whose fan-out the share limiter will not pay before any upstream call", async () => {
    // Every share charge is refused: each source is unavailable without a call spent.
    const upstream = answers();
    const app = gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: denyAll },
      prices: { cache: memoryEdgeCache(), coingecko: { apiKey: "k" } },
    });
    for (const assets of [evmSpread(0), solSpread(0)]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- requests in order on purpose
      const res = await app.request(...request(assets));
      expect(res.status).toBe(429);
    }
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("POST /v1/prices/:family refused charges", () => {
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
    const cache = memoryEdgeCache();
    // CoinGecko's two calls are paid; every DefiLlama share charge is refused.
    const llamaDenied: RateLimiter = {
      limit: async ({ key }) => Promise.resolve({ success: !key.startsWith("defillama:") }),
    };
    const limited = gateway({
      fetch: upstream.fetch,
      now: () => NOW,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: llamaDenied },
      prices: { cache, coingecko: { apiKey: "k" } },
    });
    const res = await limited.request(...request([ETH_NATIVE, TOKEN]));
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
    const second = await open.request(...request([ETH_NATIVE, TOKEN]));
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
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: denyAll },
      prices: { cache: memoryEdgeCache(), coingecko: { apiKey: "k" } },
    }).request(...request([ETH_NATIVE]));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("POST /v1/prices/:family from CoinGecko (recorded)", () => {
  it("prices natives and tokens as the provider's exact decimals, one call per platform", async () => {
    const upstream = fakeFetch(primary());
    const evmAssets = [ETH_NATIVE, BASE_NATIVE, HYPE_NATIVE, USDC_ETH, USDC_HYPEREVM];
    const solanaAssets = [SOL_NATIVE, USDC_SOL];
    const bitcoinAssets = [BTC_NATIVE];
    const served = app(upstream);
    const responses = await Promise.all(
      [evmAssets, solanaAssets, bitcoinAssets].map(async (assets) =>
        served.request(...request(assets)),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const quoted: PricesResponse["prices"] = [];
    for (const body_ of await Promise.all(responses.map(async (res) => body(res)))) {
      expect(body_.currency).toBe("usd");
      expect(body_.missing).toStrictEqual([]);
      quoted.push(...body_.prices);
    }
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
        `${CG_SIMPLE}?ids=ethereum,hyperliquid&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
        `${CG_SIMPLE}?ids=solana&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
        `${CG_SIMPLE}?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
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
    const served = app(upstream);
    const btc = await body(await served.request(...request([BTC_NATIVE], "eur")));
    const eth = await body(await served.request(...request([ETH_NATIVE], "eur")));
    expect(btc.currency).toBe("eur");
    expect(eth.currency).toBe("eur");
    expect(btc.prices.map((q) => q.price)).toStrictEqual([literal(cgEur, "bitcoin", "eur")]);
    expect(eth.prices.map((q) => q.price)).toStrictEqual([literal(cgEur, "ethereum", "eur")]);
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
    const served = app(upstream);
    const btc = await body(await served.request(...request([BTC_NATIVE])));
    const dead = await body(await served.request(...request([DEAD])));
    expect(btc.prices.map((q) => q.asset)).toStrictEqual([BTC_NATIVE]);
    expect(dead.missing).toStrictEqual([DEAD]);
    const llama = upstream.callsTo(DEFILLAMA_API).map((c) => c.url);
    expect(llama).toStrictEqual([
      `${LLAMA_CURRENT}ethereum:0x000000000000000000000000000000000000dead`,
      `${LLAMA_PERCENT}ethereum:0x000000000000000000000000000000000000dead?period=24h`,
    ]);
  });

  it("answers unsupported for assets no provider maps, without calling one", async () => {
    const upstream = fakeFetch({});
    const res = await app(upstream).request(
      ...request([
        "eip155:11155111/slip44:60",
        "eip155:11155111/erc20:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
      ]),
    );
    await expect(body(res)).resolves.toStrictEqual({
      currency: "usd",
      prices: [],
      missing: [],
      unsupported: [
        "eip155:11155111/slip44:60",
        "eip155:11155111/erc20:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
      ],
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it("prices TRX and USDT-TRON, keeping the base58 contract case (recorded)", async () => {
    const upstream = fakeFetch(
      primary({ [CG_SIMPLE]: replay(cgTron), [cgToken("tron")]: replay(cgTronToken) }),
    );
    const res = await app(upstream, {}, () => TRON_NOW).request(
      ...request([TRX_NATIVE, USDT_TRON]),
    );
    expect(res.status).toBe(200);
    const { prices: quoted, missing } = await body(res);
    expect(missing).toStrictEqual([]);
    expect(quoted).toStrictEqual([
      {
        asset: TRX_NATIVE,
        price: literal(cgTron, "tron", "usd"),
        change24h: plainDecimal(Number(literal(cgTron, "tron", "usd_24h_change")), 8),
        updatedAt: Number(literal(cgTron, "tron", "last_updated_at")) * 1000,
      },
      {
        asset: USDT_TRON,
        price: literal(cgTronToken, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "usd"),
        change24h: plainDecimal(
          Number(literal(cgTronToken, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "usd_24h_change")),
          8,
        ),
        updatedAt:
          Number(literal(cgTronToken, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "last_updated_at")) *
          1000,
      },
    ]);
    // The base58 address reaches the provider unlowercased — its answer keys the same string.
    expect(
      upstream
        .callsTo(COINGECKO_API)
        .map((c) => c.url)
        .toSorted(),
    ).toStrictEqual(
      [
        `${CG_SIMPLE}?ids=tron&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
        `${cgToken("tron")}?contract_addresses=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true&precision=full`,
      ].toSorted(),
    );
  });
});

describe("POST /v1/prices/:family failover", () => {
  it.each([
    ["a 429", replay(cgRateLimited)],
    ["a 400 (the keyless batch limit)", replay(cgLimit400)],
    ["a malformed body", () => new Response("<html>")],
    ["an unexpected shape", () => Response.json({ ethereum: { usd: "1800" } })],
  ])("serves USD from DefiLlama when CoinGecko answers %s", async (_name, failure) => {
    const upstream = fakeFetch(primary({ [CG_SIMPLE]: failure }));
    const served = app(upstream);
    const resEvm = await served.request(...request([ETH_NATIVE]));
    const resBtc = await served.request(...request([BTC_NATIVE]));
    for (const res of [resEvm, resBtc]) {
      expect(res.status).toBe(200);
      expect(res.headers.get(PROVIDERS_HEADER)).toBe("defillama");
    }
    const evm = await body(resEvm);
    const btc = await body(resBtc);
    expect(evm.missing).toStrictEqual([]);
    expect(btc.missing).toStrictEqual([]);
    const quoted = [...evm.prices, ...btc.prices];
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
    expect(
      upstream
        .callsTo(LLAMA_CURRENT)
        .map((c) => c.url)
        .toSorted(),
    ).toStrictEqual(
      [`${LLAMA_CURRENT}coingecko:ethereum`, `${LLAMA_CURRENT}coingecko:bitcoin`].toSorted(),
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
    const res = await app(upstream, { coingecko: false }).request(...request(tokens));
    const { prices: quoted, missing } = await body(res);
    expect(missing).toStrictEqual([]);
    expect(quoted.map((q) => q.change24h)).toStrictEqual(quoted.map(() => null));
    expect(quoted.every((q) => q.price.startsWith("0.999"))).toBe(true);
  });

  it("maps TRX to coingecko:tron and its token to tron:<base58> (recorded)", async () => {
    const upstream = fakeFetch({
      [LLAMA_CURRENT]: replay(llamaTron),
      [LLAMA_PERCENT]: replay(llamaTronPercent),
    });
    const res = await app(upstream, { coingecko: false }, () => TRON_NOW).request(
      ...request([TRX_NATIVE, USDT_TRON]),
    );
    const { prices: quoted, missing } = await body(res);
    expect(missing).toStrictEqual([]);
    expect(quoted).toStrictEqual([
      {
        asset: TRX_NATIVE,
        price: literal(llamaTron, "coingecko:tron", "price"),
        change24h: plainDecimal(
          Number(/"coingecko:tron":(-?[0-9.e+-]+)/.exec(llamaTronPercent.body)?.[1]),
          8,
        ),
        updatedAt: Number(literal(llamaTron, "coingecko:tron", "timestamp")) * 1000,
      },
      {
        asset: USDT_TRON,
        price: literal(llamaTron, "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "price"),
        change24h: plainDecimal(
          Number(
            /"tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t":(-?[0-9.e+-]+)/.exec(
              llamaTronPercent.body,
            )?.[1],
          ),
          8,
        ),
        updatedAt:
          Number(literal(llamaTron, "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "timestamp")) * 1000,
      },
    ]);
    expect(upstream.callsTo(LLAMA_CURRENT)[0]?.url).toBe(
      `${LLAMA_CURRENT}coingecko:tron,tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`,
    );
  });

  it("drops a DefiLlama price below its confidence floor", async () => {
    const upstream = fakeFetch({
      [LLAMA_CURRENT]: () =>
        Response.json({
          coins: { "coingecko:bitcoin": { price: 64000, timestamp: NOW / 1000, confidence: 0.5 } },
        }),
      [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
    });
    const res = await app(upstream, { coingecko: false }).request(...request([BTC_NATIVE]));
    const dropped = await body(res);
    expect(dropped.missing).toStrictEqual([BTC_NATIVE]);
  });

  it("serves the fallback alone when no CoinGecko key is configured", async () => {
    const upstream = fakeFetch(primary());
    const res = await app(upstream, { coingecko: false }).request(...request([BTC_NATIVE]));
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
    const res = await app(upstream).request(...request([BTC_NATIVE]));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("503s a non-USD request when the primary fails — the fallback quotes USD only", async () => {
    const upstream = fakeFetch(primary({ [CG_SIMPLE]: replay(cgRateLimited) }));
    const res = await app(upstream).request(...request([BTC_NATIVE], "eur"));
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
    const served = app(upstream);
    const res = await served.request(...request([BTC_NATIVE]));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    const { prices: quoted } = await body(res);
    expect(quoted.map((q) => q.asset)).toStrictEqual([BTC_NATIVE]);
    // The same provider failure on a request with nothing priced answers 503.
    const dead = await served.request(...request([DEAD]));
    expect(dead.status).toBe(503);
  });
});

describe("POST /v1/prices/:family attempt cancellation", () => {
  it("cancels a failed attempt's other in-flight calls", async () => {
    let solanaSignal: AbortSignal | undefined;
    const upstream = fakeFetch(
      primary({
        [cgToken("ethereum")]: () => new Response("batch limit", { status: 400 }),
        [cgToken("solana")]: async (call, signal) => {
          solanaSignal = signal;
          return replay(cgSolana)(call, signal);
        },
      }),
    );
    const served = app(upstream);
    const resSol = await served.request(...request([USDC_SOL]));
    const resEth = await served.request(...request([USDC_ETH]));
    // Ethereum's 400 fails CoinGecko outright on the evm request — solana's paid answer is kept
    // while DefiLlama alone prices what ethereum's call lost.
    expect(resSol.status).toBe(200);
    expect(resSol.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    expect(resEth.status).toBe(200);
    expect(resEth.headers.get(PROVIDERS_HEADER)).toBe("defillama");
    expect(solanaSignal?.aborted).toBe(false);
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
    const served = app(upstream);
    for (const res of [
      await served.request(...request([USDC_ETH])),
      await served.request(...request([USDC_SOL])),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    }
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal.aborted).toBe(false);
    }
  });
});

describe("POST /v1/prices/:family cache", () => {
  it("serves a cached asset for 30 s, then asks the provider again", async () => {
    const cache = memoryEdgeCache();
    const upstream = fakeFetch(primary());
    let now = NOW;
    const served = app(upstream, { cache }, () => now);
    await served.request(...request([BTC_NATIVE]));
    expect(cache.ttls).toStrictEqual([30]);
    expect([...cache.data.keys()]).toStrictEqual([`usd/${BTC_NATIVE}`]);

    now += 29_999;
    const cached = await served.request(...request([BTC_NATIVE]));
    const cachedBody = await body(cached);
    expect(cachedBody.prices[0]?.price).toBe(literal(cgSimple, "bitcoin", "usd"));
    expect(cached.headers.get(PROVIDERS_HEADER)).toBe("coingecko");
    expect(upstream.calls).toHaveLength(1);

    now += 1;
    await served.request(...request([BTC_NATIVE]));
    expect(upstream.calls).toHaveLength(2);
  });

  it("caches per currency and asset, never per client", async () => {
    const cache = memoryEdgeCache();
    const upstream = fakeFetch(primary({ [CG_SIMPLE]: replay(cgEur) }));
    const served = app(upstream, { cache });
    await served.request(pricesPath("bitcoin"), {
      ...init([BTC_NATIVE], "eur"),
      headers: headers({ "content-type": "application/json", "x-client-id": "f".repeat(32) }),
    });
    await served.request(...request([BTC_NATIVE], "eur"));
    expect(upstream.calls).toHaveLength(1);
    expect([...cache.data.keys()]).toStrictEqual([`eur/${BTC_NATIVE}`]);
  });

  it("caches an unpriced asset only when every provider answered", async () => {
    const cache = memoryEdgeCache();
    const answered = fakeFetch(
      primary({
        [cgToken("ethereum")]: replay(cgUnknown),
        [LLAMA_CURRENT]: () => Response.json({ coins: {} }),
        [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
      }),
    );
    await app(answered, { cache }).request(...request([DEAD]));
    const storedDead = cache.data.get(`usd/${DEAD}`);
    expect(storedDead).toBeDefined();
    expect(JSON.parse(String(storedDead))).toMatchObject({ quote: null });
    await app(answered, { cache }).request(...request([DEAD]));
    expect(answered.calls).toHaveLength(3);

    const partial = memoryEdgeCache();
    const failing = fakeFetch(primary({ [cgToken("ethereum")]: replay(cgRateLimited) }));
    const served = app(failing, { cache: partial });
    await served.request(...request([BTC_NATIVE]));
    // The evm request's only CoinGecko read 429s outright, so DEAD stays unpriced and is NOT
    // cached — a source that might have answered cannot be claimed to have answered missing.
    const dead = await served.request(...request([DEAD]));
    expect(dead.status).toBe(503);
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
    }).request(...request([BTC_NATIVE]));
    expect(res.status).toBe(200);
    expect(lines.filter((l) => l.includes("price-cache-failure"))).toStrictEqual([
      JSON.stringify({ event: "price-cache-failure", op: "get" }),
      JSON.stringify({ event: "price-cache-failure", op: "put" }),
    ]);

    const corrupt = memoryEdgeCache();
    corrupt.data.set(
      `usd/${BTC_NATIVE}`,
      JSON.stringify({
        expiresAt: NOW + 1,
        provider: "x",
        quote: { asset: BTC_NATIVE, price: "1e9", change24h: null, updatedAt: NOW },
      }),
    );
    const fresh = fakeFetch(primary());
    const again = await app(fresh, { cache: corrupt }).request(...request([BTC_NATIVE]));
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

describe("POST /v1/prices/:family provider edge cases", () => {
  it("answers a null 24 h change when CoinGecko omits the field", async () => {
    const upstream = fakeFetch(
      primary({
        [CG_SIMPLE]: () =>
          Response.json({ bitcoin: { usd: 64000.5, last_updated_at: NOW / 1000 } }),
      }),
    );
    const res = await app(upstream).request(...request([BTC_NATIVE]));
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
    const res = await app(upstream, { coingecko: false }).request(...request([BTC_NATIVE]));
    expect(res.status).toBe(200);
    const { missing } = await body(res);
    expect(missing).toStrictEqual([BTC_NATIVE]);
  });

  it("503s when DefiLlama answers a body its schema cannot read", async () => {
    const upstream = fakeFetch({
      [LLAMA_CURRENT]: () => Response.json({ unexpected: true }),
      [LLAMA_PERCENT]: () => Response.json({ coins: {} }),
    });
    const res = await app(upstream, { coingecko: false }).request(...request([BTC_NATIVE]));
    expect(res.status).toBe(503);
  });
});

describe("quotePrices", () => {
  const deps = (
    sources: ReadonlyArray<PriceSource>,
    forwarder: Forwarder = meteringForwarder,
  ): PriceDeps => ({
    forwarder,
    cache: memoryEdgeCache(),
    sources,
    now: () => NOW,
    log: () => {},
  });

  const fakeSource = (value: ReadonlyMap<string, RawQuote>): PriceSource => {
    const provider = testProvider("fake");
    return {
      provider,
      serves: () => true,
      quote: async (send) => {
        await send({ url: provider.url, cost: 1 });
        return value;
      },
    };
  };

  /** Runs the attempt against a `send` that meters each call like the real forwarder does. */
  const meteringForwarder: Forwarder = {
    run: async (providers, attempt, options) => {
      const [provider] = providers;
      if (provider === undefined) {
        throw new Error("no providers");
      }
      return {
        value: await attempt(async (request) => {
          const charge = await options.meter(provider.account, request.cost);
          if (!charge.ok) {
            // One-provider walk: the surfaced answer is the client's own refusal.
            throw new GatewayHttpError(
              charge.reason === "rate-limited" ? 429 : 413,
              charge.reason,
              charge.retryAfterSeconds,
            );
          }
          return {
            status: 200,
            ok: true,
            headers: new Headers(),
            text: async () => Promise.resolve("{}"),
            body: null,
          };
        }, provider),
        providerId: provider.id,
      };
    },
  };

  /** A forwarder that fails the `dead` source's attempt with a 503. */
  const deadForwarder: Forwarder = {
    run: async (providers, attempt, options) => {
      const [provider] = providers;
      return provider?.id === "dead"
        ? Promise.reject(new GatewayHttpError(503, "unavailable", 30))
        : meteringForwarder.run(providers, attempt, options);
    },
  };

  /** A share meter that pays for `budget` units, then reports the limiter's 429 refusal. */
  const meterUpTo = (budget: number): Meter => {
    const limiter = countBefore(budget);
    return async (_account, units) => {
      const { success } = await limiter.limit({ key: "share", delta: units });
      return success ? { ok: true } : { ok: false, reason: "rate-limited", retryAfterSeconds: 60 };
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
      async () => Promise.resolve({ ok: true }),
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
      quotePrices(deps([source], forwarder), { currency: "usd", assets: [ETH_NATIVE] }, async () =>
        Promise.resolve({ ok: true }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("answers what earlier sources priced when a later share charge is refused", async () => {
    const quote = { price: 1810.44, change24h: undefined, updatedAtSeconds: NOW / 1000 };
    const provider = testProvider("never");
    const never: PriceSource = {
      provider,
      serves: () => true,
      // The meter refuses this call before the source's own code would run.
      quote: async (send) => {
        await send({ url: provider.url, cost: 1 });
        throw new TypeError("must not be called");
      },
    };
    const { response } = await quotePrices(
      deps([fakeSource(new Map([[ETH_NATIVE, quote]])), never]),
      { currency: "usd", assets: [ETH_NATIVE, BTC_NATIVE] },
      meterUpTo(1),
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
        meterUpTo(0),
      ),
    ).rejects.toMatchObject({ status: 429, code: "rate-limited" });
  });

  it("answers 503 over 429 when a provider failed and a charge was refused", async () => {
    const quote = { price: 1810.44, change24h: undefined, updatedAtSeconds: NOW / 1000 };
    const dead = { ...fakeSource(new Map()), provider: testProvider("dead") };
    await expect(
      quotePrices(
        deps([dead, fakeSource(new Map([[BTC_NATIVE, quote]]))], deadForwarder),
        { currency: "usd", assets: [ETH_NATIVE, BTC_NATIVE] },
        meterUpTo(0),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("prices-assets tables", () => {
  it("maps every production EVM network's tokens to a provider platform", () => {
    // BOB has no CoinGecko asset platform — its token prices are absent by design.
    const unmapped = new Set(["eip155:60808"]);
    for (const id of PRODUCTION_NETWORKS.map((n) => n.id).filter((id) =>
      id.startsWith("eip155:"),
    )) {
      expect(TOKEN_PLATFORMS[id] !== undefined).toBe(!unmapped.has(id));
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
