import * as z from "zod/mini";

import { parseWith } from "@qntx/wallet-engine/gateway/contract";

import { ProviderFailure } from "./forward.ts";
import { providerJson } from "./prices.ts";
import type { PriceSource, RawQuote } from "./prices.ts";

export const DEFILLAMA_API = "https://coins.llama.fi";

/**
 * DefiLlama's own score for a price; below this the quote is dropped. Every recorded answer, the
 * `coingecko:` keys and chain tokens alike, scored 0.999 — a thin DEX-derived price scores lower.
 */
export const MIN_DEFILLAMA_CONFIDENCE = 0.9;

const currentPrices = z.object({
  coins: z.record(
    z.string(),
    z.object({ price: z.number(), timestamp: z.number(), confidence: z.optional(z.number()) }),
  ),
});

const percentages = z.object({ coins: z.record(z.string(), z.number()) });

const parsed = async <S extends z.ZodMiniType>(
  schema: S,
  response: Response,
): Promise<z.output<S>> => {
  const body = parseWith(schema, await providerJson(response));
  if (body === undefined) {
    throw new ProviderFailure("malformed", false);
  }
  return body;
};

/**
 * DefiLlama's keyless coins API, the fallback: USD only, one `/prices/current` and one
 * `/percentage` call for the whole batch. It prices major coins from CoinGecko itself, so it covers
 * an outage of the primary, not a wrong answer from it; its own value is the long tail CoinGecko
 * lacks (HyperEVM tokens among them).
 */
export const defillamaSource: PriceSource = {
  provider: { id: "defillama", url: DEFILLAMA_API },
  serves: (currency) => currency === "usd",
  quote: async (fetch, _currency, targets, signal) => {
    const keys = [...new Set([...targets.values()].map((target) => target.defillama))].join(",");
    const [current, change] = await Promise.all([
      fetch(`${DEFILLAMA_API}/prices/current/${keys}`, { signal }).then(async (response) =>
        parsed(currentPrices, response),
      ),
      fetch(`${DEFILLAMA_API}/percentage/${keys}?period=24h`, { signal }).then(async (response) =>
        parsed(percentages, response),
      ),
    ]);
    return new Map(
      [...targets].flatMap(([asset, { defillama }]): Array<readonly [string, RawQuote]> => {
        const entry = current.coins[defillama];
        if (entry === undefined || (entry.confidence ?? 0) < MIN_DEFILLAMA_CONFIDENCE) {
          return [];
        }
        return [
          [
            asset,
            {
              price: entry.price,
              change24h: change.coins[defillama],
              updatedAtSeconds: entry.timestamp,
            },
          ],
        ];
      }),
    );
  },
};
