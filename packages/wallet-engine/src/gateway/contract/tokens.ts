import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";
import { caip2 } from "./primitives.ts";

/** Per-network caps the route enforces — bigger lists are never published. */
export const TOKEN_LIST_MAX_ENTRIES = { evm: 1500, solana: 5000 } as const;

export const TOKEN_LIST_SOURCES = ["uniswap", "coingecko", "jupiter"] as const;
export type TokenListSource = (typeof TOKEN_LIST_SOURCES)[number];

const CONTROL = /\p{C}/u;

/**
 * Display text a host renders verbatim: bounded in UTF-16 units, free of control, format,
 * unassigned and private-use characters, and without leading or trailing whitespace.
 */
const displayText = (max: number) =>
  z.string().check(
    z.minLength(1),
    z.maxLength(max),
    z.refine((value) => !CONTROL.test(value), { error: "control character" }),
    z.refine((value) => value === value.trim(), { error: "outer whitespace" }),
  );

export const tokenSymbol = displayText(20);
export const tokenName = displayText(64);

export const tokenListEntry = z.object({
  address: z.string(),
  symbol: tokenSymbol,
  name: tokenName,
  decimals: z.int().check(z.gte(0), z.lte(255)),
});

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The network pins the address shape and the entry cap; eip155 addresses are lowercase hex and
 * every list is sorted by plain `<` string order — unique and canonical, so one list has exactly
 * one serialization.
 */
const validForNetwork = (doc: {
  readonly network: string;
  readonly tokens: ReadonlyArray<{ readonly address: string }>;
}): boolean => {
  const [namespace] = doc.network.split(":");
  const rule =
    namespace === "eip155"
      ? { pattern: EVM_ADDRESS, max: TOKEN_LIST_MAX_ENTRIES.evm }
      : namespace === "solana"
        ? { pattern: SOLANA_ADDRESS, max: TOKEN_LIST_MAX_ENTRIES.solana }
        : undefined;
  if (rule === undefined || doc.tokens.length > rule.max) {
    return false;
  }
  return doc.tokens.every(
    (token, i) =>
      rule.pattern.test(token.address) &&
      (i === 0 || (doc.tokens[i - 1]?.address ?? "") < token.address),
  );
};

export const tokenListResponse = z
  .object({
    network: caip2,
    /** Monotonic per network — a smaller version than the stored one is a rollback. */
    version: z.int().check(z.nonnegative()),
    sources: z.array(z.enum(TOKEN_LIST_SOURCES)).check(z.minLength(1)),
    tokens: z.array(tokenListEntry).check(z.maxLength(TOKEN_LIST_MAX_ENTRIES.solana)),
  })
  .check(z.refine(validForNetwork, { error: "entries do not fit the network" }));

export const tokenList = endpoint("GET", "/v1/tokens/:caip2", z.undefined(), tokenListResponse);

/** The token list path for one network. */
export const tokenListPath = (caip2: string): string => tokenList.path.replace(":caip2", caip2);

export type TokenListResponse = z.infer<typeof tokenListResponse>;
export type TokenListEntry = z.infer<typeof tokenListEntry>;
