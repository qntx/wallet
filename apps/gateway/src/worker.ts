import { PUSH_FAMILIES, PUSH_PLATFORMS } from "@qntx/wallet-engine/gateway/contract";

import type { WorkerEnv } from "./env.ts";
import { zeroExConfig } from "./providers/zerox.ts";
import type { PushNamespace, PushService } from "./push/backend.ts";
import { pushRuntimeFor } from "./push/runtime.ts";
import type { PushRuntime } from "./push/runtime.ts";
import type { RiskStore } from "./risk/phishing.ts";
import { tokenListSources } from "./tokens/sources.ts";
import type { TokenListUpstream } from "./tokens/sources.ts";
import type { GatewayOptions, PriceCache } from "./types.ts";
import { upstreamFor } from "./upstream.ts";

/**
 * The configured token-list sources — one call shared by `gatewayFor` (which networks the route can
 * ever serve) and `scheduled` (what the hourly build fetches), so they cannot drift apart.
 */
export const tokenSourcesFor = (env: WorkerEnv): ReadonlyArray<TokenListUpstream> =>
  tokenListSources({ coingecko: env.COINGECKO_API_KEY, jupiter: env.JUPITER_API_KEY });

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

/**
 * The push service for `GatewayOptions.push`, or `undefined` — enabled only when the seal key, at
 * least one sender and at least one family config all exist (a complete Alchemy watcher env is the
 * only family today, so Solana/Bitcoin/TRON keep answering empty capabilities). Malformed secrets
 * throw at isolate startup.
 */
export async function pushServiceFor(
  env: WorkerEnv,
  runtime?: PushRuntime,
): Promise<PushService | undefined> {
  const resolved =
    runtime ??
    (await pushRuntimeFor(
      env,
      async (input, init) => fetch(input, init),
      (line) => console.log(line),
    ));
  const { materials, alchemy, families } = resolved;
  const served = PUSH_FAMILIES.filter((family) => families[family] !== undefined);
  if (materials === undefined || served.length === 0) {
    return undefined;
  }
  const namespace: PushNamespace = env.PUSH;
  return {
    platforms: PUSH_PLATFORMS.filter((platform) => materials.senders[platform] !== undefined),
    families: served,
    backend: (family) => {
      const object = namespace.get(namespace.idFromName(family));
      return {
        subscribe: async (request) => object.subscribe(family, request),
        unsubscribe: async (id) => object.unsubscribe(family, id),
        watch: async (request) => object.watch(family, request),
        ingest: async (items) => object.ingest(family, items),
      };
    },
    ...(alchemy === undefined ? {} : { alchemy: alchemy.hooks }),
    limiter: env.PUSH_LIMITER,
  };
}

/** Maps the worker's env bindings into gateway options; called once per isolate. */
export function gatewayFor(env: WorkerEnv): GatewayOptions {
  const zeroEx = zeroExConfig(env);
  const base = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    limiters: {
      ip: env.IP_LIMITER,
      rpc: env.RPC_LIMITER,
      default: env.DEFAULT_LIMITER,
      share: env.SHARE_LIMITER,
    },
    corsOrigins: env.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
    risk: riskStoreOf(env.RISK),
    tokens: riskStoreOf(env.RISK),
    tokenNetworks: new Set(tokenSourcesFor(env).flatMap((source) => source.networks)),
    ...(zeroEx === undefined ? {} : { zeroEx }),
  };
  const cache = priceCacheOf(() => caches.default);
  const upstream = upstreamFor(env, fetch, (line) => console.log(line));
  if (env.NETWORKS === "production") {
    return {
      ...base,
      networks: upstream.networks,
      accounts: upstream.accounts,
      budget: upstream.budget,
      // Both environments run behind Cloudflare, which always sets cf-connecting-ip.
      clientAddress: "required",
      auth: upstream.auth,
      jupiter: { apiKey: env.JUPITER_API_KEY },
      prices: { cache, coingecko: { apiKey: env.COINGECKO_API_KEY } },
    };
  }
  return {
    ...base,
    networks: upstream.networks,
    accounts: upstream.accounts,
    budget: upstream.budget,
    // Both environments run behind Cloudflare, which always sets cf-connecting-ip.
    clientAddress: "required",
    auth: upstream.auth,
    prices: {
      cache,
      ...(env.COINGECKO_API_KEY === undefined
        ? {}
        : { coingecko: { apiKey: env.COINGECKO_API_KEY } }),
    },
    ...(env.JUPITER_API_KEY === undefined ? {} : { jupiter: { apiKey: env.JUPITER_API_KEY } }),
  };
}
