/**
 * Where each priceable asset id lives at each price provider. CoinGecko ids and asset platforms are
 * from `GET /api/v3/asset_platforms` (read 2026-11-18); DefiLlama chain keys were probed on
 * `coins.llama.fi/prices/current` for each chain's USDC (2026-11-18). DefiLlama prices native coins
 * through its `coingecko:` keys.
 */

/** One asset as both providers address it. */
export type PriceTarget = {
  readonly coingecko:
    | { readonly kind: "coin"; readonly id: string }
    | { readonly kind: "token"; readonly platform: string; readonly address: string };
  readonly defillama: string;
};

/** Native asset id → CoinGecko coin id. */
const NATIVE_COINS: Readonly<Record<string, string>> = {
  "eip155:1/slip44:60": "ethereum",
  "eip155:8453/slip44:60": "ethereum",
  "eip155:42161/slip44:60": "ethereum",
  "eip155:10/slip44:60": "ethereum",
  "eip155:137/slip44:966": "polygon-ecosystem-token",
  "eip155:56/slip44:714": "binancecoin",
  "eip155:999/slip44:2457": "hyperliquid",
  "eip155:43114/slip44:9000": "avalanche-2",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501": "solana",
  "bip122:000000000019d6689c085ae165831e93/slip44:0": "bitcoin",
};

/** Token network → CoinGecko asset platform and DefiLlama chain key. */
const TOKEN_PLATFORMS: Readonly<
  Record<string, { readonly coingecko: string; readonly defillama: string }>
> = {
  "eip155:1": { coingecko: "ethereum", defillama: "ethereum" },
  "eip155:8453": { coingecko: "base", defillama: "base" },
  "eip155:42161": { coingecko: "arbitrum-one", defillama: "arbitrum" },
  "eip155:10": { coingecko: "optimistic-ethereum", defillama: "optimism" },
  "eip155:137": { coingecko: "polygon-pos", defillama: "polygon" },
  "eip155:56": { coingecko: "binance-smart-chain", defillama: "bsc" },
  "eip155:999": { coingecko: "hyperevm", defillama: "hyperliquid" },
  "eip155:43114": { coingecko: "avalanche", defillama: "avax" },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": { coingecko: "solana", defillama: "solana" },
};

/** The provider addresses of a contract-valid asset id, or `undefined` when no provider prices it. */
export function priceTarget(asset: string): PriceTarget | undefined {
  const coin = NATIVE_COINS[asset];
  if (coin !== undefined) {
    return { coingecko: { kind: "coin", id: coin }, defillama: `coingecko:${coin}` };
  }
  const [network = "", reference = ""] = asset.split("/");
  const platform = TOKEN_PLATFORMS[network];
  const [, address] = reference.split(":");
  if (platform === undefined || address === undefined || reference.startsWith("slip44:")) {
    return undefined;
  }
  return {
    coingecko: { kind: "token", platform: platform.coingecko, address },
    defillama: `${platform.defillama}:${address}`,
  };
}
