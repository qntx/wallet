import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import { PROVIDERS_HEADER, prices, pricesRequest } from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import { quotePrices } from "../providers/prices.ts";
import type { PriceDeps } from "../providers/prices.ts";

/** A full batch of the longest asset ids is ~10 kB of JSON. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * `POST /v1/prices` — spot prices and 24 h change for a batch of assets in one fiat currency. The
 * request pays one rate-limit unit, plus one per upstream call its cache misses fan out to. The
 * answer is per-client (it names the client's assets), so it is `no-store`; reuse happens per asset
 * in the gateway's own cache.
 */
export function pricesRoutes(deps: PriceDeps): Hono<{ Variables: RateLimitVariables }> {
  return new Hono<{ Variables: RateLimitVariables }>().post(
    prices.path,
    limitBody(MAX_BODY_BYTES),
    sValidator("json", pricesRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const request = c.req.valid("json");
      const { response, providers } = await quotePrices(deps, request, c.get("charge"));
      return c.json(response, 200, {
        "cache-control": "no-store",
        [PROVIDERS_HEADER]: providers.join(","),
      });
    },
  );
}
