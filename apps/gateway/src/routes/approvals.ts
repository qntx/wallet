import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import {
  PROVIDERS_HEADER,
  approvals,
  approvalsRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import { alchemyApprovalCandidates, approvalsProviders } from "../providers/approvals-alchemy.ts";
import type { Forwarder } from "../providers/forward.ts";

/** The request is a JSON body of `{address}` — a few dozen bytes. */
const MAX_BODY_BYTES = 4096;

type Deps = {
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
  readonly log: (line: string) => void;
};

/**
 * `POST /v1/approvals/:caip2` — EVM approval CANDIDATES for `{address}`: the keys only (token,
 * spender, block), display-only — the engine confirms every one on chain before it means anything.
 * One `eth_blockNumber` plus four `eth_getLogs` per upstream run.
 */
export function approvalsRoutes({
  forwarder,
  served,
  log,
}: Deps): Hono<{ Variables: NetworkVariables & RateLimitVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables & RateLimitVariables }>();
  routes.post(
    approvals.path,
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["evm"]),
    sValidator("json", approvalsRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const network = c.get("network");
      const providers = approvalsProviders(network);
      // No configured approvals provider for this network: permanent, not a provider outage.
      if (providers.length === 0) {
        throw new GatewayHttpError(404, "unsupported");
      }
      const body = c.req.valid("json");
      const { value, providerId } = await alchemyApprovalCandidates(
        forwarder,
        providers,
        { address: body.address },
        c.get("meter"),
        log,
      );
      return c.json(value, 200, { [PROVIDERS_HEADER]: providerId });
    },
  );
  return routes;
}
