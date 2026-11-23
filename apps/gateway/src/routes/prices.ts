import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import {
  PROVIDERS_HEADER,
  parseWith,
  priceAssetFamily,
  priceFamily,
  prices,
  pricesRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import { quotePrices } from "../providers/prices.ts";
import type { PriceDeps } from "../providers/prices.ts";

/** A full batch of the longest asset ids is ~10 kB of JSON. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * `POST /v1/prices/:family` — spot prices and 24 h change for a batch of assets in one fiat
 * currency. Requests are partitioned by chain family: the route's family is the client-id scope the
 * engine sends it under, and the body may name only that family's assets, so one request never
 * carries a cross-family portfolio. Each upstream call a cache miss fans out to is billed to the
 * request's share of the source. The answer is per-client (it names the client's assets), so it is
 * `no-store`; reuse happens per asset in the gateway's own cache.
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
      // An unknown family answers like an unmatched route — it is not a served resource.
      const family = parseWith(priceFamily, c.req.param("family"));
      if (family === undefined) {
        throw new GatewayHttpError(404, "not-found");
      }
      const request = c.req.valid("json");
      if (request.assets.some((asset) => priceAssetFamily(asset) !== family)) {
        throw new GatewayHttpError(400, "invalid-request");
      }
      const { response, providers } = await quotePrices(deps, request, c.get("meter"));
      return c.json(response, 200, {
        "cache-control": "no-store",
        [PROVIDERS_HEADER]: providers.join(","),
      });
    },
  );
}
