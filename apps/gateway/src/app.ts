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
import { ACROSS_PROVIDER } from "./providers/across.ts";
import { createForwarder } from "./providers/forward.ts";
import { JUPITER_PROVIDER } from "./providers/jupiter.ts";
import { COINGECKO_API, coingeckoSource } from "./providers/prices-coingecko.ts";
import { DEFILLAMA_API, defillamaSource } from "./providers/prices-defillama.ts";
import { ZEROX_PROVIDER } from "./providers/zerox.ts";
import { esploraRoutes } from "./routes/esplora.ts";
import { healthRoutes } from "./routes/health.ts";
import { historyRoutes } from "./routes/history.ts";
import { networksRoutes } from "./routes/networks.ts";
import { pricesRoutes } from "./routes/prices.ts";
import { quotesRoutes } from "./routes/quotes.ts";
import { riskRoutes } from "./routes/risk.ts";
import { rpcRoutes } from "./routes/rpc.ts";
import { tokensRoutes } from "./routes/tokens.ts";
import type { GatewayOptions, ResolvedProvider } from "./types.ts";

export type { GatewayOptions } from "./types.ts";

/**
 * Builds the gateway. `options.fetch` goes to the forwarder alone: every route reaches an upstream
 * through it, so breaker accounting has one owner.
 */
export function createGateway(
  options: GatewayOptions,
): Hono<{ Variables: ClientIdVariables & RateLimitVariables }> {
  const served = indexNetworks(options.networks, options.auth, options.accounts);
  /** Resolves a code-built provider's billing account (`provider.id`) into the provider itself. */
  const priced = (provider: { readonly id: string; readonly url: string }): ResolvedProvider => {
    const account = options.accounts[provider.id];
    if (account === undefined) {
      throw new Error(`provider ${provider.id} has no account`);
    }
    if (account.costs.kind !== "request") {
      throw new Error(`provider ${provider.id} has a ${account.costs.kind} cost model`);
    }
    return { ...provider, account: provider.id, costs: account.costs };
  };
  const log = options.log ?? ((line) => console.log(line));
  const forwarder = createForwarder(options.fetch, log, { budget: options.budget });
  const deps = { forwarder, served };
  const allowedOrigins = new Set(options.corsOrigins);

  const app = new Hono<{ Variables: ClientIdVariables & RateLimitVariables }>();
  app.use(requestLog(log));
  app.use(
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowHeaders: ["content-type", "if-none-match", CLIENT_ID_HEADER],
      allowMethods: ["GET", "POST", "OPTIONS"],
      exposeHeaders: [PROVIDERS_HEADER, "etag", "retry-after"],
      maxAge: 600,
    }),
  );
  app.use("/v1/*", requireClientId);
  app.use("/v1/*", rateLimit(options.limiters, options.accounts));
  app.route("/", healthRoutes);
  app.route("/", networksRoutes(served));
  app.route("/", rpcRoutes(deps));
  app.route("/", historyRoutes({ ...deps, log }));
  app.route("/", esploraRoutes(deps));
  app.route(
    "/",
    quotesRoutes({
      forwarder,
      zeroEx: options.zeroEx,
      jupiter: options.jupiter,
      providers: {
        zerox: priced(ZEROX_PROVIDER),
        jupiter: priced(JUPITER_PROVIDER),
        across: priced(ACROSS_PROVIDER),
      },
    }),
  );
  app.route("/", riskRoutes(options.risk));
  app.route("/", tokensRoutes({ served, store: options.tokens }));
  app.route(
    "/",
    pricesRoutes({
      forwarder,
      cache: options.prices.cache,
      sources: [
        ...(options.prices.coingecko === undefined
          ? []
          : [
              coingeckoSource(
                priced({ id: "coingecko", url: COINGECKO_API }),
                options.prices.coingecko.apiKey,
              ),
            ]),
        defillamaSource(priced({ id: "defillama", url: DEFILLAMA_API })),
      ],
      now: options.now ?? (() => Date.now()),
      log,
    }),
  );
  app.onError(mapError(log));
  app.notFound(notFound);
  return app;
}
