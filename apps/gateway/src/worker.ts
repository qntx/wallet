import { PUSH_FAMILIES, PUSH_PLATFORMS } from "@qntx/wallet-engine/gateway/contract";
import type { PushFamily } from "@qntx/wallet-engine/gateway/contract";

import { durableBudget } from "./budget/leased.ts";
import { PRODUCTION_ACCOUNTS, STAGING_ACCOUNTS } from "./config/accounts.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "./config/networks.ts";
import { bearer, blockstreamAuth, header } from "./providers/auth.ts";
import { zeroExConfig } from "./providers/zerox.ts";
import type { PushNamespace, PushService } from "./push/backend.ts";
import type { PushFamilyConfig } from "./push/core.ts";
import { pushFamilies, pushMaterials } from "./push/runtime.ts";
import type { RiskStore } from "./risk/phishing.ts";
import { tokenListSources } from "./tokens/sources.ts";
import type { TokenListUpstream } from "./tokens/sources.ts";
import type { GatewayOptions, PriceCache } from "./types.ts";

/**
 * Optional values no environment requires: the 0x integrator fee, staging's Jupiter and CoinGecko
 * keys, and the push secrets — absent ones disable the feature rather than failing a deploy
 * (`secrets.required` stays push-free so deploy-check has nothing new to demand).
 */
type OptionalEnv = {
  readonly ZEROX_FEE_RECIPIENT?: string;
  readonly ZEROX_FEE_BPS?: string;
  readonly JUPITER_API_KEY?: string;
  readonly COINGECKO_API_KEY?: string;
  readonly PUSH_SEAL_KEY?: string;
  readonly APNS_KEY?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
  readonly APNS_TOPIC?: string;
  readonly FCM_SERVICE_ACCOUNT?: string;
};

export type WorkerEnv = (Cloudflare.StagingEnv | Cloudflare.ProductionEnv) & OptionalEnv;

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
 * least one sender and at least one family config all exist (`pushFamilies` is `{}` until the
 * watcher layer, so production advertises empty capabilities for now). Malformed secrets throw at
 * isolate startup.
 */
export async function pushServiceFor(
  env: WorkerEnv,
  families: Partial<Record<PushFamily, PushFamilyConfig>> = pushFamilies,
): Promise<PushService | undefined> {
  const materials = await pushMaterials(
    env,
    async (input, init) => fetch(input, init),
    () => Date.now(),
  );
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
      };
    },
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
  const accounts = env.NETWORKS === "production" ? PRODUCTION_ACCOUNTS : STAGING_ACCOUNTS;
  const budget = durableBudget(
    env.PROVIDER_BUDGET,
    accounts,
    () => Date.now(),
    (line) => console.log(line),
  );
  if (env.NETWORKS === "production") {
    return {
      ...base,
      networks: PRODUCTION_NETWORKS,
      accounts,
      budget,
      // Both environments run behind Cloudflare, which always sets cf-connecting-ip.
      clientAddress: "required",
      auth: {
        alchemy: bearer(env.ALCHEMY_API_KEY),
        drpc: header("Drpc-Key", env.DRPC_API_KEY),
        ankr: header("x-api-key", env.ANKR_API_KEY),
        blockstream: blockstreamAuth({
          fetch: async (input, init) => fetch(input, init),
          clientId: env.BLOCKSTREAM_CLIENT_ID,
          clientSecret: env.BLOCKSTREAM_CLIENT_SECRET,
          now: () => Date.now(),
        }),
        trongrid: header("TRON-PRO-API-KEY", env.TRONGRID_API_KEY),
        tatum: header("x-api-key", env.TATUM_API_KEY),
      },
      jupiter: { apiKey: env.JUPITER_API_KEY },
      prices: { cache, coingecko: { apiKey: env.COINGECKO_API_KEY } },
    };
  }
  return {
    ...base,
    networks: STAGING_NETWORKS,
    accounts,
    budget,
    // Both environments run behind Cloudflare, which always sets cf-connecting-ip.
    clientAddress: "required",
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
