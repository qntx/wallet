import { Hono } from "hono";

import {
  PROVIDER_PIN_HEADER,
  PROVIDERS_HEADER,
  esploraPathAllowed,
} from "@qntx/wallet-engine/gateway/contract";

import { requestCost } from "../budget/costs.ts";
import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import { capStream } from "../providers/body.ts";
import type { Forwarder } from "../providers/forward.ts";
import { ProviderFailure, REFUSED_STATUSES } from "../providers/forward.ts";

/** Raw transactions are at most ~400 kB; hex doubles that. */
const MAX_BODY_BYTES = 1_000_000;
/** 2x a max-weight transaction's hex, 6x the largest address/txs page measured; it streams. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** The streamed body outlives the attempt; a trickling upstream still ends within 30 s. */
const BODY_DEADLINE_MS = 30_000;
const PREFIX_SEGMENTS = 4; // "", "v1", "esplora", ":caip2"

type Deps = {
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
};

/** `GET|POST /v1/esplora/:caip2/*` — allow-listed Esplora paths, bodies passed through. */
export function esploraRoutes({
  forwarder,
  served,
}: Deps): Hono<{ Variables: NetworkVariables & RateLimitVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables & RateLimitVariables }>();
  routes.on(
    ["GET", "POST"],
    "/v1/esplora/:caip2/*",
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["bitcoin"]),
    async (c) => {
      const network = c.get("network");
      const path = `/${new URL(c.req.url).pathname.split("/").slice(PREFIX_SEGMENTS).join("/")}`;
      if (!esploraPathAllowed(c.req.method, path)) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      // Esplora forwards to the network's own provider set, which the pin cannot select — a pin
      // here would be silently ignored, so it is refused before any upstream call.
      if (c.req.header(PROVIDER_PIN_HEADER) !== undefined) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      // Every allow-listed path is one bounded upstream call, billed one request credit.
      const body = c.req.method === "POST" ? await c.req.text() : undefined;

      const { value, providerId } = await forwarder.run(
        network.providers,
        async (send, provider) => {
          const response = await send({
            url: `${provider.url}${path}`,
            method: c.req.method === "POST" ? "POST" : "GET",
            ...(body === undefined ? {} : { headers: { "content-type": "text/plain" }, body }),
            bodyDeadlineMs: BODY_DEADLINE_MS,
            cost: requestCost(provider.costs),
          });
          // 400/404 (bad request, unknown tx) are the upstream's real answer; 401 and 403 (an
          // access or bot block) refused the call.
          if (REFUSED_STATUSES.has(response.status)) {
            throw new ProviderFailure(`status-${response.status}`, true);
          }
          const declared = Number(response.headers.get("content-length") ?? 0);
          if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
            // The caller chose a resource too large to relay; no failover, no breaker cost.
            throw new GatewayHttpError(400, "invalid-request");
          }
          return {
            status: response.status,
            contentType: response.headers.get("content-type"),
            body: response.body === null ? null : capStream(response.body, MAX_RESPONSE_BYTES),
          };
        },
        { meter: c.get("meter"), broadcast: path === "/tx" },
      );

      return new Response(value.body, {
        status: value.status,
        headers: {
          ...(value.contentType === null ? {} : { "content-type": value.contentType }),
          [PROVIDERS_HEADER]: providerId,
        },
      });
    },
  );
  return routes;
}
