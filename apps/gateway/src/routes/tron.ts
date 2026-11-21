import { Hono } from "hono";

import {
  PROVIDERS_HEADER,
  TRON_BROADCAST_PATH,
  TRON_INDEXER_PATHS,
  accepts,
  isTronIndexerPath,
  parseTronJson,
  parseWith,
  tron,
  tronPathEntry,
} from "@qntx/wallet-engine/gateway/contract";

import { requestCost } from "../budget/costs.ts";
import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import type { Forwarder, UpstreamResponse } from "../providers/forward.ts";
import {
  ProviderFailure,
  REFUSED_STATUSES,
  REQUEST_ERROR_STATUSES,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
} from "../providers/forward.ts";
import { tronIndexerProviders, tronIndexerUrl } from "../providers/tron.ts";

/** A broadcasthex body can carry the node's 500 KiB transaction cap as hex. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Blocks and TRC-10-heavy accounts reach a few MB. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PREFIX_SEGMENTS = 4; // "", "v1", "tron", ":caip2"

type Deps = {
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
};

/**
 * The response body as JSON satisfying `schema`: a body that fails to parse or fails the schema is
 * the provider's `malformed` failure — failover, never breaker-counted.
 */
const respond = async (
  response: UpstreamResponse,
  schema: Parameters<typeof accepts>[0],
): Promise<string> => {
  if (!response.ok) {
    if (REQUEST_ERROR_STATUSES.has(response.status)) {
      // The upstream rejected the request itself; its body is never forwarded.
      throw new GatewayHttpError(400, "invalid-request");
    }
    throw new ProviderFailure(`status-${response.status}`, REFUSED_STATUSES.has(response.status));
  }
  const text = await response.text(MAX_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    /* int64 fields arrive as bare JSON numbers; JSON.parse would round them before the schema
       could accept their bigint form. */
    parsed = parseTronJson(text);
  } catch {
    throw new ProviderFailure("malformed", false);
  }
  if (!accepts(schema, parsed)) {
    throw new ProviderFailure("malformed", false);
  }
  return text;
};

/** `POST /v1/tron/:caip2/*` — allow-listed node API paths plus the TronGrid indexer paths. */
export function tronRoutes({
  forwarder,
  served,
}: Deps): Hono<{ Variables: NetworkVariables & RateLimitVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables & RateLimitVariables }>();
  routes.post(tron.path, limitBody(MAX_BODY_BYTES), resolveNetwork(served, ["tron"]), async (c) => {
    const network = c.get("network");
    const path = `/${new URL(c.req.url).pathname.split("/").slice(PREFIX_SEGMENTS).join("/")}`;
    const entry = tronPathEntry(path);
    if (entry === undefined) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    const body: unknown = await c.req.json().catch(() => {
      throw new GatewayHttpError(400, "invalid-request");
    });
    if (!accepts(entry.request, body)) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    // Every allow-listed path is one bounded upstream call, billed one request credit.
    const meter = c.get("meter");

    if (isTronIndexerPath(path)) {
      // The body already satisfied this same schema; re-parsing narrows it for the URL build.
      const request = parseWith(TRON_INDEXER_PATHS[path].request, body);
      if (request === undefined) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      const providers = tronIndexerProviders(network);
      if (providers.length === 0) {
        throw new GatewayHttpError(503, "unavailable", UNAVAILABLE_RETRY_AFTER_SECONDS);
      }
      const { value, providerId } = await forwarder.run(
        providers,
        async (send, provider) =>
          respond(
            await send({
              url: tronIndexerUrl(provider, path, request),
              method: "GET",
              cost: requestCost(provider.costs),
            }),
            entry.response,
          ),
        { meter },
      );
      return c.body(value, 200, {
        "content-type": "application/json",
        [PROVIDERS_HEADER]: providerId,
      });
    }

    const payload = JSON.stringify(body);
    const { value, providerId } = await forwarder.run(
      network.providers,
      async (send, provider) =>
        respond(
          await send({
            url: `${provider.url}${path}`,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
            cost: requestCost(provider.costs),
          }),
          entry.response,
        ),
      { meter, broadcast: path === TRON_BROADCAST_PATH },
    );
    return c.body(value, 200, {
      "content-type": "application/json",
      [PROVIDERS_HEADER]: providerId,
    });
  });
  return routes;
}
