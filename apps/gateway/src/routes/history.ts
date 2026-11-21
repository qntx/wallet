import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import {
  HISTORY_PAGE_MAX,
  PROVIDERS_HEADER,
  history,
  historyRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { resolveNetwork } from "../middleware/network.ts";
import type { NetworkVariables, ResolvedNetwork } from "../middleware/network.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import type { Forwarder } from "../providers/forward.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "../providers/forward.ts";
import { alchemyHistoryPage, historyProviders } from "../providers/history-alchemy.ts";

/** The request is a JSON body of `{address, cursor?, limit?}` — a few hundred bytes. */
const MAX_BODY_BYTES = 4096;

type Deps = {
  readonly forwarder: Forwarder;
  readonly served: ReadonlyMap<string, ResolvedNetwork>;
  readonly log: (line: string) => void;
};

/** `POST /v1/history/:caip2` — EVM transfer history, newest first, `cursor` pages backwards. */
export function historyRoutes({
  forwarder,
  served,
  log,
}: Deps): Hono<{ Variables: NetworkVariables & RateLimitVariables }> {
  const routes = new Hono<{ Variables: NetworkVariables & RateLimitVariables }>();
  routes.post(
    history.path,
    limitBody(MAX_BODY_BYTES),
    resolveNetwork(served, ["evm"]),
    sValidator("json", historyRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const network = c.get("network");
      const providers = historyProviders(network);
      if (providers.length === 0) {
        throw new GatewayHttpError(503, "unavailable", UNAVAILABLE_RETRY_AFTER_SECONDS);
      }
      const body = c.req.valid("json");
      const { value, providerId } = await alchemyHistoryPage(
        forwarder,
        providers,
        {
          chainId: Number(network.id.split(":")[1]),
          address: body.address,
          ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
          limit: body.limit ?? HISTORY_PAGE_MAX,
        },
        c.get("meter"),
        log,
      );
      return c.json(value, 200, { [PROVIDERS_HEADER]: providerId });
    },
  );
  return routes;
}
