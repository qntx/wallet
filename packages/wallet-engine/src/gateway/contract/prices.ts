import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

/** Quote currencies the price route serves — ISO 4217 codes, lowercase as the providers spell them. */
export const FIAT_CURRENCIES = [
  "usd",
  "eur",
  "gbp",
  "jpy",
  "cny",
  "krw",
  "hkd",
  "sgd",
  "cad",
  "aud",
  "chf",
] as const;

export const fiatCurrency = z.enum(FIAT_CURRENCIES);

export type FiatCurrency = z.infer<typeof fiatCurrency>;

/** The most assets one `prices` request may name. */
export const MAX_PRICE_ASSETS = 100;

/**
 * SLIP-44 coin type of the native asset on every mainnet the price route values (SLIP-0044
 * registry, satoshilabs/slips slip-0044.md @ 02e7b618; ETH-native L2s reuse 60). Testnets are
 * absent on purpose: their coins have no price.
 */
export const NATIVE_SLIP44: Readonly<Record<string, number>> = {
  "eip155:1": 60,
  "eip155:8453": 60,
  "eip155:42161": 60,
  "eip155:10": 60,
  "eip155:137": 966,
  "eip155:56": 714,
  "eip155:999": 2457,
  "eip155:43114": 9000,
  "eip155:4663": 60,
  "eip155:143": 268435779,
  "eip155:5042": 5042,
  "eip155:1672": 3172,
  "eip155:25": 394,
  "eip155:100": 700,
  "eip155:747474": 60,
  "eip155:80094": 8008,
  "eip155:480": 60,
  "eip155:130": 60,
  "eip155:1329": 19000118,
  "eip155:59144": 60,
  "eip155:42220": 52752,
  "eip155:146": 10007,
  "eip155:324": 60,
  "eip155:1868": 60,
  "eip155:4326": 60,
  "eip155:8217": 8217,
  "eip155:57073": 60,
  "eip155:534352": 60,
  "eip155:60808": 60,
  "eip155:204": 714,
  "eip155:42170": 60,
  "eip155:167000": 60,
  "eip155:7777777": 60,
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 501,
  "tron:728126428": 195,
  "bip122:000000000019d6689c085ae165831e93": 0,
};

/**
 * A priceable CAIP-19 asset id in its one canonical spelling: a native coin (`<caip2>/slip44:<n>`),
 * an ERC-20 with its address lowercase (`eip155:<n>/erc20:0x…`), or an SPL mint
 * (`solana:<ref>/token:<mint>`). A single spelling per asset keeps batches and cache keys free of
 * duplicates.
 */
export const priceAssetId = z
  .string()
  .check(
    z.regex(
      /^(?:[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/slip44:(?:0|[1-9][0-9]{0,9})|eip155:[1-9][0-9]{0,9}\/erc20:0x[0-9a-f]{40}|solana:[1-9A-HJ-NP-Za-km-z]{32}\/token:[1-9A-HJ-NP-Za-km-z]{32,44}|tron:728126428\/trc20:T[1-9A-HJ-NP-Za-km-z]{33})$/,
    ),
  );

/** The asset id of `network`'s native coin, or `undefined` for a network without prices. */
export const nativeAssetId = (network: string): string | undefined => {
  const slip44 = NATIVE_SLIP44[network];
  return slip44 === undefined ? undefined : `${network}/slip44:${String(slip44)}`;
};

/**
 * The asset id of a token on `network` (an ERC-20 address or an SPL mint), or `undefined` for a
 * network without prices or a token address the network does not spell that way.
 */
export const tokenAssetId = (network: string, address: string): string | undefined => {
  if (NATIVE_SLIP44[network] === undefined) {
    return undefined;
  }
  const id = network.startsWith("eip155:")
    ? `${network}/erc20:${address.toLowerCase()}`
    : network.startsWith("tron:")
      ? `${network}/trc20:${address}`
      : `${network}/token:${address}`;
  return z.safeParse(priceAssetId, id).success ? id : undefined;
};

/**
 * Fiat per whole unit of the asset as a canonical decimal string: positive, at most 12 integer
 * digits and 18 decimals, no trailing zeros — never a binary float on the wire.
 */
export const fiatPrice = z
  .string()
  .check(z.regex(/^(?:[1-9][0-9]{0,11}(?:\.[0-9]{0,17}[1-9])?|0\.[0-9]{0,17}[1-9])$/));

/** A 24 h change in percent as a canonical decimal string, at most 8 decimals, never below -100. */
export const percentChange = z.string().check(
  z.regex(/^-?(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,7}[1-9])?$/),
  z.refine((value) => value !== "-0" && Number(value) >= -100),
);

export const priceQuote = z.object({
  asset: priceAssetId,
  price: fiatPrice,
  /** `null` when the provider has no 24 h change for the asset. */
  change24h: z.union([percentChange, z.null()]),
  /** When the provider last updated the price, Unix ms. */
  updatedAt: z.number().check(z.int(), z.positive()),
});

/** The `prices` request: spot prices of up to {@link MAX_PRICE_ASSETS} distinct assets. */
export const pricesRequest = z.object({
  currency: fiatCurrency,
  assets: z.array(priceAssetId).check(
    z.minLength(1),
    z.maxLength(MAX_PRICE_ASSETS),
    z.refine((assets) => new Set(assets).size === assets.length),
  ),
});

/**
 * Every requested asset is in exactly one of `prices` (priced), `missing` (the providers had no
 * price now — a later request may find one) or `unsupported` (the gateway has no price coverage for
 * it at all — do not retry).
 */
export const pricesResponse = z.object({
  currency: fiatCurrency,
  prices: z.array(priceQuote).check(z.maxLength(MAX_PRICE_ASSETS)),
  missing: z.array(priceAssetId).check(z.maxLength(MAX_PRICE_ASSETS)),
  unsupported: z.array(priceAssetId).check(z.maxLength(MAX_PRICE_ASSETS)),
});

/**
 * The gateway scopes a price request is partitioned by: one per chain family, each sent under that
 * family's own client id.
 */
export const PRICE_FAMILIES = ["evm", "solana", "bitcoin", "tron"] as const;

export type PriceFamily = (typeof PRICE_FAMILIES)[number];

export const priceFamily = z.enum(PRICE_FAMILIES);

/**
 * The family whose scope prices `asset`, by its CAIP-2 namespace (eip155, solana, bip122, tron);
 * `undefined` for any other.
 */
export const priceAssetFamily = (asset: string): PriceFamily | undefined => {
  switch (asset.slice(0, asset.indexOf(":"))) {
    case "eip155":
      return "evm";
    case "solana":
      return "solana";
    case "bip122":
      return "bitcoin";
    case "tron":
      return "tron";
    default:
      return undefined;
  }
};

/**
 * `POST /v1/prices/:family` — no address is sent, but the asset set describes a portfolio, so it
 * travels in the body and per family scope: a request never names another family's assets, so the
 * portfolio links no scopes beyond what each scope's own traffic already shows.
 */
export const prices = endpoint("POST", "/v1/prices/:family", pricesRequest, pricesResponse);

/** The prices path for one family scope. */
export const pricesPath = (family: PriceFamily): string => prices.path.replace(":family", family);

export type PriceQuote = z.infer<typeof priceQuote>;
export type PricesRequest = z.infer<typeof pricesRequest>;
export type PricesResponse = z.infer<typeof pricesResponse>;
