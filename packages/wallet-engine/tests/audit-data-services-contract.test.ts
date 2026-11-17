import { describe, expect, it } from "vite-plus/test";
/**
 * Audit A1 lane data-services — prototype of the proposed data-layer contract additions, written in
 * the style of `src/gateway/contract/*` (zod/mini, `endpoint()`), with the schema rules that carry
 * the trust and privacy design: address-bearing routes are POST (no address in a URL), amounts are
 * base-unit decimal strings, every flag carries reason codes, partial results name what is stale.
 * This is a design artefact, not product code.
 */
import * as z from "zod/mini";

import { caip2, endpoint } from "../src/gateway/contract/index.ts";

const MAX_ADDRESSES = 10;

/** CAIP-19 `chain_id/asset_namespace:asset_reference` (`/token_id` for NFTs). */
const caip19 = z
  .string()
  .check(
    z.regex(
      /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}(\/[-.%a-zA-Z0-9]{1,78})?$/,
    ),
  );
/** Base-unit amount, a non-negative integer as decimal. */
const amount = z.string().check(z.regex(/^(0|[1-9][0-9]{0,77})$/));
/** Signed base-unit delta for activity entries. */
const delta = z.string().check(z.regex(/^-?(0|[1-9][0-9]{0,77})$/));
/** Fiat value as a decimal string — never a float on the wire. */
const fiat = z.string().check(z.regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/));
const currency = z.enum(["usd", "eur", "gbp", "jpy", "cny", "krw", "btc"]);
const unixMs = z.number().check(z.int(), z.nonnegative());
const family = z.enum(["evm", "solana"]);
const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));
const solanaAddress = z.string().check(z.regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/));
const address = z.union([evmAddress, solanaAddress]);

/** Why the gateway flags an asset or an activity entry; the client shows the codes. */
const SPAM_REASONS = [
  "provider-flag",
  "risk-scan",
  "low-liquidity",
  "symbol-impersonation",
  "unicode-symbol",
  "zero-value-transfer",
  "lookalike-counterparty",
  "unsolicited",
] as const;
const spam = z.object({ flagged: z.boolean(), reasons: z.array(z.enum(SPAM_REASONS)) });

const tokenMeta = z.object({
  symbol: z.string().check(z.maxLength(32)),
  name: z.string().check(z.maxLength(64)),
  decimals: z.number().check(z.int(), z.minimum(0), z.maximum(36)),
  /** A gateway image-proxy URL, never a third-party URL. */
  logo: z.optional(z.string().check(z.regex(/^\/v1\/img\/[A-Za-z0-9_-]{16,128}$/))),
});

const price = z.object({
  value: fiat,
  change24h: z.optional(z.number()),
  updatedAt: unixMs,
  /** The two independent sources disagreed by more than the threshold. */
  divergent: z.boolean(),
});

/* ---------- /v1/portfolio ---------- */

export const portfolioRequest = z.object({
  family,
  addresses: z.array(address).check(z.minLength(1), z.maxLength(MAX_ADDRESSES)),
  networks: z.array(caip2).check(z.minLength(1), z.maxLength(16)),
  currency,
});
const holding = z.object({
  address,
  network: caip2,
  asset: caip19,
  amount,
  token: tokenMeta,
  price: z.optional(price),
  spam,
});
export const portfolioResponse = z.object({
  holdings: z.array(holding),
  /** Networks the provider failed for: the client keeps its previous rows for them. */
  stale: z.array(caip2),
  /** Block (EVM) or slot (Solana) per network the balances were read at. */
  at: z.record(caip2, z.string().check(z.regex(/^[0-9]+$/))),
});
export const portfolio = endpoint("POST", "/v1/portfolio", portfolioRequest, portfolioResponse);

/* ---------- /v1/prices ---------- */

export const pricesRequest = z.object({
  assets: z.array(caip19).check(z.minLength(1), z.maxLength(100)),
  currency,
});
export const pricesResponse = z.object({
  prices: z.array(z.object({ asset: caip19, ...price.shape })),
  missing: z.array(caip19),
});
export const prices = endpoint("POST", "/v1/prices", pricesRequest, pricesResponse);

/** No address: cacheable GET keyed by asset, currency and range. */
export const priceHistoryRequest = z.object({
  range: z.enum(["1d", "7d", "30d", "1y", "max"]),
  currency,
});
export const priceHistoryResponse = z.object({
  points: z.array(z.tuple([unixMs, fiat])).check(z.maxLength(500)),
});
export const priceHistory = endpoint(
  "GET",
  "/v1/prices/:caip19/history",
  priceHistoryRequest,
  priceHistoryResponse,
);

/* ---------- /v1/activity ---------- */

const change = z.object({
  asset: caip19,
  amount: delta,
  token: z.optional(tokenMeta),
  from: z.optional(address),
  to: z.optional(address),
});
const activityItem = z.object({
  network: caip2,
  /** Transaction hash (EVM) or signature (Solana) — the client verifies it before relying on it. */
  hash: z.string().check(z.regex(/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/)),
  timestamp: unixMs,
  block: z.string().check(z.regex(/^[0-9]+$/)),
  status: z.enum(["confirmed", "failed"]),
  direction: z.enum(["in", "out", "self", "none"]),
  kind: z.enum(["transfer", "swap", "approve", "mint", "burn", "stake", "contract", "unknown"]),
  counterparty: z.optional(address),
  changes: z.array(change).check(z.maxLength(64)),
  /** Paid by the address itself; absent for incoming entries. */
  fee: z.optional(amount),
  spam,
});
export const activityRequest = z.object({
  family,
  address,
  networks: z.array(caip2).check(z.minLength(1), z.maxLength(16)),
  cursor: z.optional(z.string().check(z.maxLength(512))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
});
export const activityResponse = z.object({
  items: z.array(activityItem).check(z.maxLength(50)),
  cursor: z.union([z.string(), z.null()]),
  stale: z.array(caip2),
});
export const activity = endpoint("POST", "/v1/activity", activityRequest, activityResponse);

/* ---------- /v1/nfts ---------- */

const nft = z.object({
  asset: caip19,
  network: caip2,
  owner: address,
  standard: z.enum(["erc721", "erc1155", "metaplex", "metaplex-core", "compressed"]),
  amount,
  collection: z.object({ id: z.string(), name: z.string(), verified: z.boolean() }),
  name: z.string().check(z.maxLength(128)),
  image: z.optional(z.string().check(z.regex(/^\/v1\/img\/[A-Za-z0-9_-]{16,128}$/))),
  spam,
});
export const nftsRequest = z.object({
  family,
  addresses: z.array(address).check(z.minLength(1), z.maxLength(MAX_ADDRESSES)),
  networks: z.array(caip2).check(z.minLength(1), z.maxLength(16)),
  cursor: z.optional(z.string().check(z.maxLength(512))),
});
export const nftsResponse = z.object({
  items: z.array(nft).check(z.maxLength(100)),
  cursor: z.union([z.string(), z.null()]),
  stale: z.array(caip2),
});
export const nfts = endpoint("POST", "/v1/nfts", nftsRequest, nftsResponse);

/* ---------- /v1/notifications ---------- */

export const notificationsRegisterRequest = z.object({
  platform: z.enum(["apns", "fcm", "webpush"]),
  /** APNs/FCM device token or the Web Push subscription endpoint, opaque to the client. */
  token: z.string().check(z.minLength(16), z.maxLength(4096)),
  /** Watched addresses per family; replaces the previous set for this token. */
  watch: z
    .array(z.object({ family: z.enum(["evm", "solana", "bitcoin", "spark"]), address: z.string() }))
    .check(z.maxLength(50)),
});
export const notificationsRegisterResponse = z.object({
  /** Random handle the client uses to delete the registration; the token is never echoed. */
  id: z.string().check(z.regex(/^[0-9a-f]{32}$/)),
  expiresAt: unixMs,
});
export const notificationsRegister = endpoint(
  "POST",
  "/v1/notifications",
  notificationsRegisterRequest,
  notificationsRegisterResponse,
);

const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER = "0x2222222222222222222222222222222222222222";

describe("DS contract prototype", () => {
  it("accepts a portfolio response with a stale network and a flagged airdrop", () => {
    const ok = z.safeParse(portfolio.response, {
      holdings: [
        {
          address: OWNER,
          network: "eip155:8453",
          asset: USDC_BASE,
          amount: "5000000",
          token: { symbol: "USDC", name: "USD Coin", decimals: 6 },
          price: {
            value: "0.9998",
            change24h: -0.01,
            updatedAt: 1_763_424_000_000,
            divergent: false,
          },
          spam: { flagged: false, reasons: [] },
        },
        {
          address: OWNER,
          network: "eip155:8453",
          asset: "eip155:8453/erc20:0x00000000000000000000000000000000000000aa",
          amount: "1000000000000000000000",
          token: { symbol: "USDC", name: "Claim at usdc-rewards.xyz", decimals: 18 },
          spam: { flagged: true, reasons: ["symbol-impersonation", "low-liquidity"] },
        },
      ],
      stale: ["eip155:999"],
      at: { "eip155:8453": "38000000" },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects float amounts, negative balances, third-party image URLs and too many addresses", () => {
    const base = {
      address: OWNER,
      network: "eip155:1",
      asset: "eip155:1/slip44:60",
      token: { symbol: "ETH", name: "Ether", decimals: 18 },
      spam: { flagged: false, reasons: [] },
    };
    for (const holding of [
      { ...base, amount: "1.5" },
      { ...base, amount: "-1" },
      { ...base, amount: "1", token: { ...base.token, logo: "https://evil.example/x.png" } },
    ]) {
      expect(
        z.safeParse(portfolio.response, { holdings: [holding], stale: [], at: {} }).success,
      ).toBe(false);
    }
    expect(
      z.safeParse(portfolio.request, {
        family: "evm",
        addresses: Array.from({ length: MAX_ADDRESSES + 1 }, () => OWNER),
        networks: ["eip155:1"],
        currency: "usd",
      }).success,
    ).toBe(false);
  });

  it("keeps every address-bearing route off the URL", () => {
    for (const route of [portfolio, prices, activity, nfts, notificationsRegister]) {
      expect(route.method).toBe("POST");
      expect(route.path).not.toMatch(/:address/);
    }
    expect(priceHistory.method).toBe("GET");
  });

  it("models a zero-value poisoning transfer as a flagged incoming entry", () => {
    const ok = z.safeParse(activity.response, {
      items: [
        {
          network: "eip155:1",
          hash: `0x${"ab".repeat(32)}`,
          timestamp: 1_763_424_000_000,
          block: "23800000",
          status: "confirmed",
          direction: "in",
          kind: "transfer",
          counterparty: "0x2222000000000000000000000000000000002222",
          changes: [
            { asset: "eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "0" },
          ],
          spam: { flagged: true, reasons: ["zero-value-transfer", "lookalike-counterparty"] },
        },
      ],
      cursor: null,
      stale: [],
    });
    expect(ok.success).toBe(true);
  });
});
