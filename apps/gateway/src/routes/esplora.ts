import { Hono } from "hono";

import { PROVIDERS_HEADER, esploraPathAllowed } from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import { capStream } from "../providers/body.ts";
import type { Forwarder } from "../providers/forward.ts";
import { ProviderFailure } from "../providers/forward.ts";

/** Raw transactions are at most ~400 kB; hex doubles that. */
const MAX_BODY_BYTES = 1_000_000;
/** 2x a max-weight transaction's hex, 6x the largest address/txs page measured; it streams. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** The streamed body outlives the attempt; a trickling upstream still ends within 30 s. */
const BODY_DEADLINE_MS = 30_000;
/** Upstream statuses where the provider provably refused the call before processing it. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
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
      // One unit per request, charged up front: every allow-listed path is bounded (block
      // heights, fee estimates, 25-tx pages, one transaction), so there is no call-cost to add.
      const body = c.req.method === "POST" ? await c.req.text() : undefined;

      const { value, providerId } = await forwarder.run(
        network.providers,
        async (provider, signal) => {
          let authHeaders: Readonly<Record<string, string>>;
          try {
            authHeaders = (await provider.auth?.()) ?? {};
          } catch {
            throw new ProviderFailure("auth", true);
          }
          const response = await fetch(`${provider.url}${path}`, {
            method: c.req.method,
            headers: {
              ...authHeaders,
              ...(body === undefined ? {} : { "content-type": "text/plain" }),
            },
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(BODY_DEADLINE_MS)]),
          });
          // 400/404 (bad request, unknown tx) are the upstream's real answer. 401 and 403 (an
          // access or bot block) and 429 refused the call; 5xx is an ambiguous provider failure.
          if (REFUSED_STATUSES.has(response.status) || response.status >= 500) {
            throw new ProviderFailure(
              `status-${response.status}`,
              REFUSED_STATUSES.has(response.status),
            );
          }
          const declared = Number(response.headers.get("content-length") ?? 0);
          if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
            // The caller chose a resource too large to relay; no failover, no breaker cost.
            throw new GatewayHttpError(400, "invalid-request");
          }
          return {
            status: response.status,
            contentType: response.headers.get("content-type"),
            // fetch bodies stream Uint8Array chunks; ReadableStream defaults its chunk type to any.
            // oxlint-disable-next-line typescript/no-unsafe-argument
            body: response.body === null ? null : capStream(response.body, MAX_RESPONSE_BYTES),
          };
        },
        { broadcast: path === "/tx" },
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
