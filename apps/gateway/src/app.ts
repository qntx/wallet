import { Hono } from "hono";
import { cors } from "hono/cors";

import { CLIENT_ID_HEADER, PROVIDERS_HEADER } from "@qntx/wallet-engine/gateway/contract";

import { requireClientId } from "./middleware/client-id.ts";
import type { ClientIdVariables } from "./middleware/client-id.ts";
import { mapError, notFound } from "./middleware/errors.ts";
import { indexNetworks } from "./middleware/network.ts";
import { rateLimit } from "./middleware/rate-limit.ts";
import type { RateLimitVariables } from "./middleware/rate-limit.ts";
import { requestLog } from "./middleware/request-log.ts";
import { createForwarder } from "./providers/forward.ts";
import { esploraRoutes } from "./routes/esplora.ts";
import { healthRoutes } from "./routes/health.ts";
import { historyRoutes } from "./routes/history.ts";
import { networksRoutes } from "./routes/networks.ts";
import { quotesRoutes } from "./routes/quotes.ts";
import { riskRoutes } from "./routes/risk.ts";
import { rpcRoutes } from "./routes/rpc.ts";
import type { GatewayOptions } from "./types.ts";

export type { GatewayOptions } from "./types.ts";

/** Builds the gateway; every upstream call goes through `options.fetch`. */
export function createGateway(
  options: GatewayOptions,
): Hono<{ Variables: ClientIdVariables & RateLimitVariables }> {
  const served = indexNetworks(options.networks, options.auth);
  const log = options.log ?? ((line) => console.log(line));
  const forwarder = createForwarder(log);
  const deps = { fetch: options.fetch, forwarder, served };
  const allowedOrigins = new Set(options.corsOrigins);

  const app = new Hono<{ Variables: ClientIdVariables & RateLimitVariables }>();
  app.use(requestLog(log));
  app.use(
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowHeaders: ["content-type", CLIENT_ID_HEADER],
      allowMethods: ["GET", "POST", "OPTIONS"],
      exposeHeaders: [PROVIDERS_HEADER, "retry-after"],
      maxAge: 600,
    }),
  );
  app.use("/v1/*", requireClientId);
  app.use("/v1/*", rateLimit(options.limiters));
  app.route("/", healthRoutes);
  app.route("/", networksRoutes(served));
  app.route("/", rpcRoutes(deps));
  app.route("/", historyRoutes({ ...deps, log }));
  app.route("/", esploraRoutes(deps));
  app.route(
    "/",
    quotesRoutes({
      fetch: options.fetch,
      forwarder,
      zeroEx: options.zeroEx,
      jupiter: options.jupiter,
    }),
  );
  app.route("/", riskRoutes(options.risk));
  app.onError(mapError(log));
  app.notFound(notFound);
  return app;
}
