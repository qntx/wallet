import type { TokenListSource } from "@qntx/wallet-engine/gateway/contract";

/** One upstream token entry before normalization — only the address is trusted to be a string. */
export type RawToken = {
  readonly address: string;
  readonly symbol: unknown;
  readonly name: unknown;
  readonly decimals: unknown;
};

/** A remote token registry: where it is fetched, which networks it feeds, how its document reads. */
export type TokenListUpstream = {
  readonly id: TokenListSource;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Networks this source feeds; `parse` returns entries for these only. Throws on a wrong shape. */
  readonly networks: ReadonlyArray<string>;
  readonly parse: (json: unknown) => ReadonlyMap<string, ReadonlyArray<RawToken>>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Token Lists documents (`{tokens: [{chainId, address, ...}]}`) filtered to `chains`. */
const tokenListDoc =
  (
    id: string,
    chains: Readonly<Record<number, string>>,
  ): ((json: unknown) => ReadonlyMap<string, ReadonlyArray<RawToken>>) =>
  (json) => {
    const tokens = isObject(json) ? json["tokens"] : undefined;
    if (!Array.isArray(tokens)) {
      throw new TypeError(`${id}: "tokens" is not an array`);
    }
    const byNetwork = new Map<string, RawToken[]>();
    for (const entry of tokens) {
      if (!isObject(entry) || typeof entry["chainId"] !== "number") {
        throw new TypeError(`${id}: malformed token entry`);
      }
      const network = chains[entry["chainId"]];
      if (network === undefined || typeof entry["address"] !== "string") {
        continue;
      }
      if (NATIVE_ALIASES[network]?.has(entry["address"].toLowerCase()) === true) {
        continue;
      }
      const list = byNetwork.get(network) ?? [];
      list.push({
        address: entry["address"],
        symbol: entry["symbol"],
        name: entry["name"],
        decimals: entry["decimals"],
      });
      byNetwork.set(network, list);
    }
    return byNetwork;
  };

/**
 * ERC-20 addresses that shadow the native coin's balance — listing them would double count it.
 * Celo's CELO: https://docs.celo.org/build/tools/contracts/core-contracts (GoldToken/CeloToken) and
 * https://docs.celo.org/learn/protocol/celo-token (token duality).
 */
const NATIVE_ALIASES: Readonly<Record<string, ReadonlySet<string>>> = {
  "eip155:42220": new Set(["0x471ece3750da237f93b8e339c536989b8978a438"]),
};

// tokens.uniswap.org (v22.34.0, read 2026-11-20/21) carries entries for every chain id below.
const UNISWAP_CHAINS: Readonly<Record<number, string>> = {
  1: "eip155:1",
  10: "eip155:10",
  56: "eip155:56",
  137: "eip155:137",
  8453: "eip155:8453",
  42161: "eip155:42161",
  43114: "eip155:43114",
  4663: "eip155:4663",
  143: "eip155:143",
  196: "eip155:196",
  480: "eip155:480",
  130: "eip155:130",
  42220: "eip155:42220",
  324: "eip155:324",
  1868: "eip155:1868",
  57073: "eip155:57073",
  7777777: "eip155:7777777",
};

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const COINGECKO_CHAINS: Readonly<Record<number, string>> = { 999: "eip155:999" };

/** Jupiter's verified list: entries tagged `deprecated`/`duplicate` or flagged `audit.isSus`. */
const jupiterDoc = (json: unknown): ReadonlyMap<string, ReadonlyArray<RawToken>> => {
  if (!Array.isArray(json)) {
    throw new TypeError("jupiter: document is not an array");
  }
  const tokens: RawToken[] = [];
  for (const entry of json) {
    if (!isObject(entry) || typeof entry["id"] !== "string") {
      throw new TypeError("jupiter: malformed token entry");
    }
    const tags = Array.isArray(entry["tags"]) ? entry["tags"] : [];
    const audit = isObject(entry["audit"]) ? entry["audit"] : undefined;
    if (
      tags.includes("deprecated") ||
      tags.includes("duplicate") ||
      audit?.["isSus"] !== undefined
    ) {
      continue;
    }
    tokens.push({
      address: entry["id"],
      symbol: entry["symbol"],
      name: entry["name"],
      decimals: entry["decimals"],
    });
  }
  return new Map([[SOLANA_MAINNET, tokens]]);
};

/**
 * The upstream token registries, keyed where a key is required. CoinGecko's Pro token_lists
 * endpoint answers only with a key — without one its network simply has no list.
 */
export function tokenListSources(keys: {
  readonly coingecko?: string | undefined;
  readonly jupiter?: string | undefined;
}): ReadonlyArray<TokenListUpstream> {
  return [
    {
      // Uniswap Labs Default list (tokens.uniswap.org), licensed GPL-3.0-or-later (npm
      // @uniswap/default-token-list); only the factual fields address, symbol, name and decimals
      // are republished.
      id: "uniswap",
      url: "https://tokens.uniswap.org",
      networks: Object.values(UNISWAP_CHAINS),
      parse: tokenListDoc("uniswap", UNISWAP_CHAINS),
    },
    ...(keys.coingecko === undefined
      ? []
      : [
          {
            // CoinGecko Pro token_lists for HyperEVM (paid plans incl. Basic). CoinGecko API
            // terms require the attribution "Powered by CoinGecko" and refreshing cached data at
            // least every 24 h; the build runs hourly.
            id: "coingecko" as const,
            url: "https://pro-api.coingecko.com/api/v3/token_lists/hyperevm/all.json",
            headers: { "x-cg-pro-api-key": keys.coingecko },
            networks: Object.values(COINGECKO_CHAINS),
            parse: tokenListDoc("coingecko", COINGECKO_CHAINS),
          },
        ]),
    {
      // Jupiter Tokens API v2 verified tag, used under the Jupiter SDK & API License Agreement
      // (developers.jup.ag/docs/legal/sdk-api-license-agreement).
      id: "jupiter",
      url: "https://api.jup.ag/tokens/v2/tag?query=verified",
      ...(keys.jupiter === undefined ? {} : { headers: { "x-api-key": keys.jupiter } }),
      networks: [SOLANA_MAINNET],
      parse: jupiterDoc,
    },
  ];
}
