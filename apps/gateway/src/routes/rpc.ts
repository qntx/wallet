import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import {
  PROVIDERS_HEADER,
  accepts,
  containsBroadcast,
  evmRpcRequest,
  rpc,
  rpcRequest,
  rpcResponse,
  solanaRpcRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { rpcCost } from "../budget/costs.ts";
import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import type { Forwarder } from "../providers/forward.ts";
import { ProviderFailure, REFUSED_STATUSES, REQUEST_ERROR_STATUSES } from "../providers/forward.ts";

/** Well above the largest raw transaction a node relays (128 kB of bytes, hex-encoded) in a batch. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * ~10x the largest ordinary response measured (0.84 MB of eth_getBlockReceipts); parsed it peaks
 * near 30 MB, leaving headroom for concurrent requests under the 128 MB isolate limit.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Deps = {
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
};

/** `POST /v1/rpc/:caip2` — allow-listed JSON-RPC 2.0 (single or batch) for EVM and Solana. */
export function rpcRoutes({
  forwarder,
  served,
}: Deps): Hono<{ Variables: NetworkVariables & RateLimitVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables & RateLimitVariables }>();
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
      // The request paid one unit up front; a batch's remaining calls pay one unit each. The
      // provider's own price (compute units) is metered per upstream call by the forwarder.
      await c.get("charge")((Array.isArray(body) ? body.length : 1) - 1);
      const payload = JSON.stringify(body);

      const { value, providerId } = await forwarder.run(
        network.providers,
        async (send, provider) => {
          const response = await send({
            url: provider.url,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
            cost: rpcCost(provider.costs, body),
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
          const text = await response.text(MAX_RESPONSE_BYTES);
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          // A JSON-RPC error object is a valid answer and is returned as-is; only a malformed
          // body is a provider failure.
          if (!accepts(rpcResponse, parsed)) {
            throw new ProviderFailure("malformed", false);
          }
          return text;
        },
        { meter: c.get("meter"), broadcast: containsBroadcast(body) },
      );

      return c.body(value, 200, {
        "content-type": "application/json",
        [PROVIDERS_HEADER]: providerId,
      });
    },
  );
  return routes;
}
