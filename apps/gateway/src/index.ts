import { createGateway } from "./app.ts";
import { STAGING_NETWORKS } from "./config/networks.ts";
import { PHISHING_SOURCES } from "./config/phishing.ts";
import { zeroExConfig } from "./providers/zerox.ts";
import { buildPhishingList } from "./risk/phishing.ts";
import type { RiskStore } from "./risk/phishing.ts";

type Gateway = ReturnType<typeof createGateway>;

const riskStore = (kv: KVNamespace): RiskStore => ({
  get: async (key) => (await kv.get(key)) ?? undefined,
  put: async (key, value) => kv.put(key, value),
});

// Bindings are stable for the life of an isolate, so the app (and its breaker state) is built once.
let gateway: Gateway | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const zeroEx = zeroExConfig(env);
    const jupiter = env.JUPITER_API_KEY === undefined ? undefined : { apiKey: env.JUPITER_API_KEY };
    gateway ??= createGateway({
      fetch: async (input, init) => fetch(input, init),
      networks: STAGING_NETWORKS,
      limiters: { rpc: env.RPC_LIMITER, default: env.DEFAULT_LIMITER },
      corsOrigins: env.CORS_ORIGINS.split(",").map((origin) => origin.trim()),
      risk: riskStore(env.RISK),
      ...(zeroEx === undefined ? {} : { zeroEx }),
      ...(jupiter === undefined ? {} : { jupiter }),
    });
    return gateway.fetch(request);
  },
  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(
      buildPhishingList({
        fetch: async (input, init) => fetch(input, init),
        store: riskStore(env.RISK),
        now: () => Date.now(),
        log: (line) => {
          console.log(line);
        },
        sources: PHISHING_SOURCES,
      }),
    );
  },
} satisfies ExportedHandler<Env>;
