import * as z from "zod/mini";

import { parseWith } from "@qntx/wallet-engine/gateway/contract";
import type { FiatCurrency } from "@qntx/wallet-engine/gateway/contract";

import { requestCost } from "../budget/costs.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import type { ResolvedProvider } from "../types.ts";
import { ProviderFailure } from "./forward.ts";
import type { PriceTarget } from "./prices-assets.ts";
import { providerJson } from "./prices.ts";
import type { PriceSource, RawQuote } from "./prices.ts";

export const COINGECKO_API = "https://pro-api.coingecko.com/api/v3";

/**
 * `/simple/price` and `/simple/token_price` share one shape: key → `{ <cur>, <cur>_24h_change,
 * last_updated_at }`.
 */
const simplePrices = z.record(z.string(), z.record(z.string(), z.union([z.number(), z.null()])));

const rawQuote = (
  // oxlint-disable-next-line typescript/no-restricted-types -- wire shape: null when the field is absent upstream
  entry: Readonly<Record<string, number | null>> | undefined,
  currency: FiatCurrency,
): RawQuote | undefined => {
  const price = entry?.[currency];
  const updated = entry?.["last_updated_at"];
  const change = entry?.[`${currency}_24h_change`];
  if (typeof price !== "number" || typeof updated !== "number") {
    return undefined;
  }
  return {
    price,
    change24h: typeof change === "number" ? change : undefined,
    updatedAtSeconds: updated,
  };
};

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  map.set(key, [...(map.get(key) ?? []), value]);
};

/** Assets by CoinGecko key: the native coins for `/simple/price`, token addresses per platform. */
const groupTargets = (
  targets: ReadonlyMap<string, PriceTarget>,
): {
  readonly coins: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly platforms: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<string>>>;
} => {
  const coins = new Map<string, string[]>();
  const platforms = new Map<string, Map<string, string[]>>();
  for (const [asset, { coingecko }] of targets) {
    if (coingecko.kind === "coin") {
      push(coins, coingecko.id, asset);
    } else {
      const byAddress = platforms.get(coingecko.platform) ?? new Map<string, string[]>();
      push(byAddress, coingecko.address, asset);
      platforms.set(coingecko.platform, byAddress);
    }
  }
  return { coins, platforms };
};

/**
 * CoinGecko's Pro API, the primary source: one `/simple/price` call for the native coins and one
 * `/simple/token_price/{platform}` call per token platform (at most 515 addresses each, above the
 * request cap). The key travels in the `x-cg-pro-api-key` header, never in the URL.
 */
export function coingeckoSource(provider: ResolvedProvider, apiKey: string): PriceSource {
  return {
    provider,
    serves: () => true,
    quote: async (send, currency, targets) => {
      const { coins, platforms } = groupTargets(targets);
      const query = `vs_currencies=${currency}&include_24hr_change=true&include_last_updated_at=true&precision=full`;
      const read = async (
        path: string,
        keys: ReadonlyMap<string, ReadonlyArray<string>>,
      ): Promise<ReadonlyArray<readonly [string, RawQuote]>> => {
        const response = await send({
          url: `${COINGECKO_API}${path}${[...keys.keys()].join(",")}&${query}`,
          headers: { "x-cg-pro-api-key": apiKey },
          cost: requestCost(provider.costs),
        });
        const body = parseWith(simplePrices, await providerJson(response));
        if (body === undefined) {
          throw new ProviderFailure("malformed", false);
        }
        return [...keys].flatMap(([key, assets]) => {
          const raw = rawQuote(body[key], currency);
          return raw === undefined ? [] : assets.map((asset) => [asset, raw] as const);
        });
      };
      const reads = [
        ...(coins.size === 0 ? [] : [read("/simple/price?ids=", coins)]),
        ...[...platforms].map(async ([platform, byAddress]) =>
          read(`/simple/token_price/${platform}?contract_addresses=`, byAddress),
        ),
      ];
      // One refused or failed platform call must not discard the platforms already paid for:
      // keep every read that answered and throw only when none did — a refusal (the request's
      // own budget) in preference, so the caller can tell refusal from provider failure.
      const settled = await Promise.allSettled(reads);
      const rejected = settled.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected.length === settled.length && settled.length > 0) {
        const reason: unknown =
          rejected.find((result) => result.reason instanceof GatewayHttpError)?.reason ??
          rejected[0]?.reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
      return new Map(
        settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
      );
    },
  };
}
