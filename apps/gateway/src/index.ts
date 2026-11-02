import { createGateway } from "./app.ts";
import { STAGING_NETWORKS } from "./config/networks.ts";

type Gateway = ReturnType<typeof createGateway>;

// Bindings are stable for the life of an isolate, so the app (and its breaker state) is built once.
let gateway: Gateway | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    gateway ??= createGateway({
      fetch: async (input, init) => fetch(input, init),
      networks: STAGING_NETWORKS,
      limiters: { rpc: env.RPC_LIMITER, default: env.DEFAULT_LIMITER },
      corsOrigins: env.CORS_ORIGINS.split(",").map((origin) => origin.trim()),
    });
    return gateway.fetch(request);
  },
} satisfies ExportedHandler<Env>;
