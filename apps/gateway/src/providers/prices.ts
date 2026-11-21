import * as z from "zod/mini";

import {
  accepts,
  fiatPrice,
  parseWith,
  percentChange,
  priceQuote,
} from "@qntx/wallet-engine/gateway/contract";
import type {
  FiatCurrency,
  PriceQuote,
  PricesRequest,
  PricesResponse,
} from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "../middleware/errors.ts";
import type { PriceCache, ResolvedProvider } from "../types.ts";
import type { Forwarder, Send, UpstreamResponse } from "./forward.ts";
import { ProviderFailure, REFUSED_STATUSES, UNAVAILABLE_RETRY_AFTER_SECONDS } from "./forward.ts";
import { priceTarget } from "./prices-assets.ts";
import type { PriceTarget } from "./prices-assets.ts";

/** How long a provider's answer for one asset is served from the cache (gateway.mdx "缓存"). */
export const PRICE_CACHE_SECONDS = 30;
/** A quote the provider last updated longer ago than this is no price at all. */
export const MAX_QUOTE_AGE_MS = 24 * 60 * 60 * 1000;
/** How far a provider's `updatedAt` may run ahead of the gateway clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** ~20x a full batch: recorded answers run ~120 bytes per asset, 100 assets ~12 kB. */
const MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * A price provider's JSON body. Any non-2xx status is a failed answer, as is a body that is not
 * JSON; neither is an outage — the assets in the request are the client's choice.
 */
export async function providerJson(response: UpstreamResponse): Promise<unknown> {
  if (!response.ok) {
    throw new ProviderFailure(`status-${response.status}`, REFUSED_STATUSES.has(response.status));
  }
  const text = await response.text(MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderFailure("malformed", false);
  }
}

/** A provider's price as it arrived: binary floats, the timestamp in Unix seconds. */
export type RawQuote = {
  readonly price: number;
  readonly change24h: number | undefined;
  readonly updatedAtSeconds: number;
};

/**
 * One price provider. `quote` answers for the assets it knows and omits the others; it throws on
 * any failure (a non-2xx status, a malformed body). `calls` is how many upstream calls `quote`
 * makes for `targets` — the request pays one rate-limit unit for each before they are sent.
 */
export type PriceSource = {
  readonly provider: ResolvedProvider;
  readonly serves: (currency: FiatCurrency) => boolean;
  readonly calls: (targets: ReadonlyMap<string, PriceTarget>) => number;
  readonly quote: (
    send: Send,
    currency: FiatCurrency,
    targets: ReadonlyMap<string, PriceTarget>,
  ) => Promise<ReadonlyMap<string, RawQuote>>;
};

export type PriceDeps = {
  readonly forwarder: Forwarder;
  readonly cache: PriceCache;
  /** Tried in order: each one is asked only for the assets every earlier one left unpriced. */
  readonly sources: ReadonlyArray<PriceSource>;
  readonly now: () => number;
  readonly log: (line: string) => void;
};

/** A cached answer: the quote, or `null` when every provider answered without a price. */
const cachedEntry = z.object({
  expiresAt: z.number(),
  provider: z.string(),
  quote: z.union([priceQuote, z.null()]),
});

// oxlint-disable-next-line typescript/no-restricted-types -- cache shape: null = every provider answered without a price
type Entry = { readonly quote: PriceQuote | null; readonly provider: string };

/**
 * `value` as a plain decimal string truncated to `maxFraction` decimals — from the number's
 * shortest round-trip spelling, so the digits are the provider's own and never pass through float
 * arithmetic. `undefined` for a non-finite number.
 */
export function plainDecimal(value: number, maxFraction: number): string | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (match === null) {
    return undefined;
  }
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const padded = point <= 0 ? "0".repeat(1 - point) + digits : digits.padEnd(point, "0");
  const at = Math.max(point, 1);
  const integer = padded.slice(0, at).replace(/^0+(?=\d)/, "");
  const decimals = padded.slice(at, at + maxFraction).replace(/0+$/, "");
  if (integer === "0" && decimals === "") {
    return "0";
  }
  return `${sign}${integer}${decimals === "" ? "" : `.${decimals}`}`;
}

/**
 * The wire quote for a provider's raw answer, or `undefined` when it is not a believable price: not
 * a positive fiat amount within the contract's bounds, or updated in the future or over a day ago.
 * A 24 h change out of bounds is dropped to `null`; the price itself still stands.
 */
export function normalizeQuote(asset: string, raw: RawQuote, now: number): PriceQuote | undefined {
  const price = plainDecimal(raw.price, 18);
  const updatedAt = raw.updatedAtSeconds * 1000;
  if (
    price === undefined ||
    !accepts(fiatPrice, price) ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt <= 0 ||
    updatedAt > now + MAX_CLOCK_SKEW_MS ||
    now - updatedAt > MAX_QUOTE_AGE_MS
  ) {
    return undefined;
  }
  const change = raw.change24h === undefined ? undefined : plainDecimal(raw.change24h, 8);
  return {
    asset,
    price,
    change24h: change !== undefined && accepts(percentChange, change) ? change : null,
    updatedAt,
  };
}

const cacheKey = (currency: FiatCurrency, asset: string): string => `${currency}/${asset}`;

async function readCached(deps: PriceDeps, key: string, now: number): Promise<Entry | undefined> {
  try {
    const raw = await deps.cache.get(key);
    if (raw === undefined) {
      return undefined;
    }
    const entry = parseWith(cachedEntry, JSON.parse(raw));
    return entry === undefined || entry.expiresAt <= now ? undefined : entry;
  } catch {
    deps.log(JSON.stringify({ event: "price-cache-failure", op: "get" }));
    return undefined;
  }
}

async function writeCached(deps: PriceDeps, key: string, entry: Entry, now: number): Promise<void> {
  try {
    await deps.cache.put(
      key,
      JSON.stringify({ ...entry, expiresAt: now + PRICE_CACHE_SECONDS * 1000 }),
      PRICE_CACHE_SECONDS,
    );
  } catch {
    deps.log(JSON.stringify({ event: "price-cache-failure", op: "put" }));
  }
}

/**
 * Prices `request.assets`: cache first, then each source in order for whatever is still unpriced,
 * `charge` paying for each source's upstream calls before they are sent. A refused charge makes
 * that source unavailable — the request's own budget is spent, not the provider's — so answers
 * already paid for are kept and the source's still-pending assets answer `missing` without being
 * cached as such. When no asset could be priced and the only failures were refused charges the
 * request rethrows the 429; when a provider failed it answers `503 unavailable` rather than
 * claiming everything is missing. An asset is cached as `missing` only when every source that
 * serves the currency answered — a failed or uncharged source might know it. Returns the response
 * and the providers whose data it carries.
 */
export async function quotePrices(
  deps: PriceDeps,
  request: PricesRequest,
  charge: (units: number) => Promise<void>,
): Promise<{ readonly response: PricesResponse; readonly providers: ReadonlyArray<string> }> {
  const { currency } = request;
  const now = deps.now();
  const known = new Map<string, PriceTarget>();
  for (const asset of request.assets) {
    const target = priceTarget(asset);
    if (target !== undefined) {
      known.set(asset, target);
    }
  }
  const resolved = new Map<string, Entry>();
  const cached = await Promise.all(
    [...known.keys()].map(
      async (asset) => [asset, await readCached(deps, cacheKey(currency, asset), now)] as const,
    ),
  );
  for (const [asset, entry] of cached) {
    if (entry !== undefined) {
      resolved.set(asset, entry);
    }
  }

  const fresh = new Map<string, Entry>();
  let failed = false;
  let chargeRefused: GatewayHttpError | undefined;
  for (const source of deps.sources.filter((s) => s.serves(currency))) {
    const pending = new Map([...known].filter(([asset]) => !resolved.has(asset)));
    if (pending.size === 0) {
      break;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each source only sees what the last left
      await charge(source.calls(pending));
    } catch (error) {
      if (!(error instanceof GatewayHttpError)) {
        throw error;
      }
      // The request's own budget is spent, not the provider's: the source is
      // unavailable, but nothing it could have answered may be cached missing.
      chargeRefused ??= error;
      continue;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each source only sees what the last left
      const { value } = await deps.forwarder.run([source.provider], async (send) =>
        source.quote(send, currency, pending),
      );
      for (const [asset, raw] of value) {
        const quote = pending.has(asset) ? normalizeQuote(asset, raw, now) : undefined;
        if (quote !== undefined) {
          const entry = { quote, provider: source.provider.id };
          resolved.set(asset, entry);
          fresh.set(asset, entry);
        }
      }
    } catch (error) {
      if (!(error instanceof GatewayHttpError)) {
        throw error;
      }
      failed = true;
    }
  }

  if (!failed && chargeRefused === undefined) {
    for (const asset of known.keys()) {
      if (!resolved.has(asset)) {
        fresh.set(asset, { quote: null, provider: "" });
      }
    }
  }
  const priced = request.assets.flatMap((asset) => {
    const quote = resolved.get(asset)?.quote;
    return quote === undefined || quote === null ? [] : [quote];
  });
  if (priced.length === 0 && failed) {
    throw new GatewayHttpError(503, "unavailable", UNAVAILABLE_RETRY_AFTER_SECONDS);
  }
  if (priced.length === 0 && chargeRefused !== undefined) {
    throw chargeRefused;
  }
  await Promise.all(
    [...fresh].map(async ([asset, entry]) =>
      writeCached(deps, cacheKey(currency, asset), entry, now),
    ),
  );
  const pricedAssets = new Set(priced.map((quote) => quote.asset));
  const providers = [
    ...new Set(
      request.assets.flatMap((asset) => {
        const entry = resolved.get(asset);
        return entry?.quote === undefined || entry.quote === null ? [] : [entry.provider];
      }),
    ),
  ];
  return {
    response: {
      currency,
      prices: priced,
      missing: request.assets.filter((asset) => !pricedAssets.has(asset)),
    },
    providers,
  };
}
