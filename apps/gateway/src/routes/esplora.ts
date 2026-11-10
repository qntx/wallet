import { Hono } from "hono";

import { PROVIDERS_HEADER, esploraPathAllowed } from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { Forwarder } from "../providers/forward.ts";

/** Raw transactions are at most ~400 kB; hex doubles that. */
const MAX_BODY_BYTES = 1_000_000;
const FAILOVER_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
const PREFIX_SEGMENTS = 4; // "", "v1", "esplora", ":caip2"

type Deps = {
  readonly fetch: typeof globalThis.fetch;
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
};

/** `GET|POST /v1/esplora/:caip2/*` — allow-listed Esplora paths, bodies passed through. */
export function esploraRoutes({
  fetch,
  forwarder,
  served,
}: Deps): Hono<{ Variables: NetworkVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables }>();
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
      const body = c.req.method === "POST" ? await c.req.text() : undefined;

      const { value, providerId } = await forwarder.run(
        network.providers,
        async (provider, signal) => {
          const authHeaders = (await provider.auth?.()) ?? {};
          const response = await fetch(`${provider.url}${path}`, {
            method: c.req.method,
            headers: {
              ...authHeaders,
              ...(body === undefined ? {} : { "content-type": "text/plain" }),
            },
            ...(body === undefined ? {} : { body }),
            signal,
          });
          // 400/404 (bad request, unknown tx) are the upstream's real answer. 401 and 403 (an
          // access or bot block), 429 and 5xx mean this provider cannot serve right now.
          if (FAILOVER_STATUSES.has(response.status) || response.status >= 500) {
            throw new Error(`upstream status ${response.status}`);
          }
          return {
            status: response.status,
            contentType: response.headers.get("content-type"),
            bytes: await response.arrayBuffer(),
          };
        },
      );

      return new Response(value.bytes, {
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
