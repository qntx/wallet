import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import {
  PROVIDERS_HEADER,
  accepts,
  evmRpcRequest,
  rpc,
  rpcRequest,
  rpcResponse,
  solanaRpcRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { Forwarder } from "../providers/forward.ts";
import { ProviderFailure } from "../providers/forward.ts";

/** Well above the largest raw transaction a node relays (128 kB of bytes, hex-encoded) in a batch. */
const MAX_BODY_BYTES = 512 * 1024;

/** Upstream statuses the request provoked: the caller's own 400 answer, never retried. */
const REQUEST_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);
/** Upstream statuses where the provider provably refused the call before processing it. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

type Deps = {
  readonly fetch: typeof globalThis.fetch;
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
};

/** `POST /v1/rpc/:caip2` — allow-listed JSON-RPC 2.0 (single or batch) for EVM and Solana. */
export function rpcRoutes({
  fetch,
  forwarder,
  served,
}: Deps): Hono<{ Variables: NetworkVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables }>();
  routes.post(
    rpc.path,
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["evm", "solana"]),
    sValidator("json", rpcRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const network = c.get("network");
      const body = c.req.valid("json");
      const allowed = network.family === "evm" ? evmRpcRequest : solanaRpcRequest;
      if (!accepts(allowed, body)) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      const payload = JSON.stringify(body);

      const { value, providerId } = await forwarder.run(
        network.providers,
        async (provider, signal) => {
          let headers: Readonly<Record<string, string>>;
          try {
            headers = (await provider.auth?.()) ?? {};
          } catch {
            // The call was never sent: a failed auth lookup cannot poison the request's outcome.
            throw new ProviderFailure("auth", true);
          }
          const response = await fetch(provider.url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: payload,
            signal,
          });
          if (!response.ok) {
            if (REQUEST_ERROR_STATUSES.has(response.status)) {
              // The upstream rejected the request itself; its body is never forwarded.
              throw new GatewayHttpError(400, "invalid-request");
            }
            throw new ProviderFailure(
              `status-${response.status}`,
              REFUSED_STATUSES.has(response.status),
            );
          }
          const text = await response.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          // A JSON-RPC error object is a valid answer and is returned as-is; only a malformed
          // body counts as a provider failure.
          if (!accepts(rpcResponse, parsed)) {
            throw new ProviderFailure("malformed", false);
          }
          return text;
        },
      );

      return c.body(value, 200, {
        "content-type": "application/json",
        [PROVIDERS_HEADER]: providerId,
      });
    },
  );
  return routes;
}
