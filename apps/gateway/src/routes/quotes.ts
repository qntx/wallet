import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import {
  swapQuote,
  swapQuoteRequest,
  swapQuoteSolana,
  swapQuoteSolanaRequest,
} from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "../middleware/errors.ts";
import type { Forwarder } from "../providers/forward.ts";
import type { JupiterConfig, JupiterQuote } from "../providers/jupiter.ts";
import { jupiterQuote } from "../providers/jupiter.ts";
import type { ZeroExQuote, ZeroExConfig } from "../providers/zerox.ts";
import { zeroExQuote } from "../providers/zerox.ts";

/**
 * `GET /v1/quotes/swap` — relays the swap quote through the configured upstream. Absent a `zeroEx`
 * option the service has no quote provider and answers `unavailable`.
 */
export function quotesRoutes(deps: {
  readonly fetch: typeof globalThis.fetch;
  readonly forwarder: Forwarder;
  readonly zeroEx: ZeroExConfig | undefined;
  readonly jupiter: JupiterConfig | undefined;
}): Hono {
  return new Hono()
    .get(
      swapQuote.path,
      sValidator("query", swapQuoteRequest, (result) => {
        if (!result.success) {
          throw new GatewayHttpError(400, "invalid-request");
        }
      }),
      async (c) => {
        if (deps.zeroEx === undefined) {
          throw new GatewayHttpError(503, "unavailable");
        }
        const { network, sellToken, buyToken, sellAmount, taker, slippageBps } =
          c.req.valid("query");
        const chainId = Number(network.split(":")[1]);
        const result: ZeroExQuote = await zeroExQuote(deps.forwarder, deps.fetch, deps.zeroEx, {
          chainId,
          sellToken,
          buyToken,
          sellAmount,
          taker,
          slippageBps,
        });
        if ("badRequest" in result) {
          throw new GatewayHttpError(400, "invalid-request");
        }
        return c.json(result);
      },
    )
    .get(
      swapQuoteSolana.path,
      sValidator("query", swapQuoteSolanaRequest, (result) => {
        if (!result.success) {
          throw new GatewayHttpError(400, "invalid-request");
        }
      }),
      async (c) => {
        /* Jupiter serves keyless — the route is always available; a configured key only sets
           the upstream header. */
        const { inputMint, outputMint, amount, taker, slippageBps } = c.req.valid("query");
        const result: JupiterQuote = await jupiterQuote(deps.forwarder, deps.fetch, deps.jupiter, {
          inputMint,
          outputMint,
          amount,
          taker,
          slippageBps,
        });
        if ("badRequest" in result) {
          throw new GatewayHttpError(400, "invalid-request");
        }
        return c.json(result);
      },
    );
}
