import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "./config/networks.ts";
import { bearer, blockstreamAuth, header } from "./providers/auth.ts";
import { zeroExConfig } from "./providers/zerox.ts";
import type { RiskStore } from "./risk/phishing.ts";
import type { GatewayOptions } from "./types.ts";

/** Optional values no environment requires: the 0x integrator fee and staging's Jupiter key. */
type OptionalEnv = {
  readonly ZEROX_FEE_RECIPIENT?: string;
  readonly ZEROX_FEE_BPS?: string;
  readonly JUPITER_API_KEY?: string;
};

export type WorkerEnv = (Cloudflare.StagingEnv | Cloudflare.ProductionEnv) & OptionalEnv;

export const riskStoreOf = (kv: KVNamespace): RiskStore => ({
  get: async (key) => (await kv.get(key)) ?? undefined,
  put: async (key, value) => kv.put(key, value),
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
    };
  }
  return {
    ...base,
    networks: STAGING_NETWORKS,
    auth: {},
    ...(env.JUPITER_API_KEY === undefined ? {} : { jupiter: { apiKey: env.JUPITER_API_KEY } }),
  };
}
