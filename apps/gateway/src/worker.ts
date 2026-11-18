import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "./config/networks.ts";
import { bearer, blockstreamAuth, header } from "./providers/auth.ts";
import { zeroExConfig } from "./providers/zerox.ts";
import type { RiskStore } from "./risk/phishing.ts";
import type { GatewayOptions, PriceCache } from "./types.ts";

/**
 * Optional values no environment requires: the 0x integrator fee, and staging's Jupiter and
 * CoinGecko keys.
 */
type OptionalEnv = {
  readonly ZEROX_FEE_RECIPIENT?: string;
  readonly ZEROX_FEE_BPS?: string;
  readonly JUPITER_API_KEY?: string;
  readonly COINGECKO_API_KEY?: string;
};

export type WorkerEnv = (Cloudflare.StagingEnv | Cloudflare.ProductionEnv) & OptionalEnv;

export const riskStoreOf = (kv: KVNamespace): RiskStore => ({
  get: async (key) => (await kv.get(key)) ?? undefined,
  put: async (key, value) => kv.put(key, value),
});

/** Price cache keys live under this synthetic origin; nothing is ever fetched from it. */
const PRICE_CACHE_ORIGIN = "https://prices.cache.invalid";

/**
 * The price cache on the Workers Cache API: free and per data centre, each entry expiring by its
 * `cache-control: max-age`. `open` is called per operation — `caches` exists only in the runtime.
 */
export const priceCacheOf = (open: () => Cache): PriceCache => ({
  get: async (key) => {
    const hit = await open().match(`${PRICE_CACHE_ORIGIN}/${key}`);
    return hit === undefined ? undefined : hit.text();
  },
  put: async (key, value, ttlSeconds) =>
    open().put(
      `${PRICE_CACHE_ORIGIN}/${key}`,
      new Response(value, {
        headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` },
      }),
    ),
});

/** Maps the worker's env bindings into gateway options; called once per isolate. */
export function gatewayFor(env: WorkerEnv): GatewayOptions {
  const zeroEx = zeroExConfig(env);
  const base = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    limiters: { ip: env.IP_LIMITER, rpc: env.RPC_LIMITER, default: env.DEFAULT_LIMITER },
    corsOrigins: env.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
    risk: riskStoreOf(env.RISK),
    ...(zeroEx === undefined ? {} : { zeroEx }),
  };
  const cache = priceCacheOf(() => caches.default);
  if (env.NETWORKS === "production") {
    return {
      ...base,
      networks: PRODUCTION_NETWORKS,
      auth: {
        alchemy: bearer(env.ALCHEMY_API_KEY),
        drpc: header("Drpc-Key", env.DRPC_API_KEY),
        blockstream: blockstreamAuth({
          fetch: async (input, init) => fetch(input, init),
          clientId: env.BLOCKSTREAM_CLIENT_ID,
          clientSecret: env.BLOCKSTREAM_CLIENT_SECRET,
          now: () => Date.now(),
        }),
      },
      jupiter: { apiKey: env.JUPITER_API_KEY },
      prices: { cache, coingecko: { apiKey: env.COINGECKO_API_KEY } },
    };
  }
  return {
    ...base,
    networks: STAGING_NETWORKS,
    auth: {},
    prices: {
      cache,
      ...(env.COINGECKO_API_KEY === undefined
        ? {}
        : { coingecko: { apiKey: env.COINGECKO_API_KEY } }),
    },
    ...(env.JUPITER_API_KEY === undefined ? {} : { jupiter: { apiKey: env.JUPITER_API_KEY } }),
  };
}
