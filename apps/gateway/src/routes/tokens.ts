import { Hono } from "hono";

import { tokenList } from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "../providers/forward.ts";
import type { TokenListStore } from "../tokens/build.ts";

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `GET /v1/tokens/:caip2` — the published token list verbatim, with a strong ETag so a client polls
 * cheaply (`if-none-match` → 304) and intermediaries may cache for an hour.
 */
export function tokensRoutes({
  served,
  store,
  tokenNetworks,
}: {
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
  readonly store: TokenListStore;
  readonly tokenNetworks: ReadonlySet<string>;
}): Hono<{ Variables: NetworkVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables }>();
  routes.get(tokenList.path, resolveNetwork(served, ["evm", "solana"]), async (c) => {
    const network = c.get("network").id;
    // No configured token source covers the network: it will never have a list here.
    if (!tokenNetworks.has(network)) {
      throw new GatewayHttpError(404, "unsupported");
    }
    const body = await store.get(`tokens:${network}`);
    // Covered but nothing stored yet: the hourly build has not landed — temporary.
    if (body === undefined) {
      throw new GatewayHttpError(503, "unavailable", UNAVAILABLE_RETRY_AFTER_SECONDS);
    }
    const etag = `"${hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}"`;
    const headers = { etag, "cache-control": "public, max-age=3600" };
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304, headers);
    }
    return c.body(body, 200, { ...headers, "content-type": "application/json" });
  });
  return routes;
}
