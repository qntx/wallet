/**
 * Where each priceable asset id lives at each price provider. CoinGecko ids and asset platforms are
 * from `GET /api/v3/asset_platforms` (read 2026-11-20); DefiLlama chain keys were probed on
 * `coins.llama.fi/prices/current` (2026-11-20) with each chain's native `:0x0000…0000` and the
 * built-in USDC/USDT. DefiLlama prices native coins through its `coingecko:` keys.
 */

/** One asset as both providers address it. */
export type PriceTarget = {
  readonly coingecko:
    | { readonly kind: "coin"; readonly id: string }
    | { readonly kind: "token"; readonly platform: string; readonly address: string };
  readonly defillama: string;
};

/** Native asset id → CoinGecko coin id. */
export const NATIVE_COINS: Readonly<Record<string, string>> = {
  "eip155:1/slip44:60": "ethereum",
  "eip155:8453/slip44:60": "ethereum",
  "eip155:42161/slip44:60": "ethereum",
  "eip155:10/slip44:60": "ethereum",
  "eip155:137/slip44:966": "polygon-ecosystem-token",
  "eip155:56/slip44:714": "binancecoin",
  "eip155:999/slip44:2457": "hyperliquid",
  "eip155:43114/slip44:9000": "avalanche-2",
  "eip155:4663/slip44:60": "ethereum",
  "eip155:143/slip44:268435779": "monad",
  "eip155:5042/slip44:5042": "usd-coin",
  "eip155:1672/slip44:3172": "pharos-network",
  "eip155:25/slip44:394": "crypto-com-chain",
  "eip155:100/slip44:700": "xdai",
  "eip155:747474/slip44:60": "ethereum",
  "eip155:80094/slip44:8008": "berachain-bera",
  "eip155:480/slip44:60": "ethereum",
  "eip155:130/slip44:60": "ethereum",
  "eip155:1329/slip44:19000118": "sei-network",
  "eip155:59144/slip44:60": "ethereum",
  "eip155:42220/slip44:52752": "celo",
  "eip155:146/slip44:10007": "sonic-3",
  "eip155:324/slip44:60": "ethereum",
  "eip155:1868/slip44:60": "ethereum",
  "eip155:4326/slip44:60": "ethereum",
  "eip155:8217/slip44:8217": "kaia",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501": "solana",
  // https://api.coingecko.com/api/v3/coins/list — the TRX coin id.
  "tron:728126428/slip44:195": "tron",
  "bip122:000000000019d6689c085ae165831e93/slip44:0": "bitcoin",
};

/** Token network → CoinGecko asset platform and DefiLlama chain key. */
export const TOKEN_PLATFORMS: Readonly<
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
  "eip155:4663": { coingecko: "robinhood", defillama: "robinhood" },
  "eip155:143": { coingecko: "monad", defillama: "monad" },
  "eip155:5042": { coingecko: "arc", defillama: "arc" },
  "eip155:9745": { coingecko: "plasma", defillama: "plasma" },
  "eip155:196": { coingecko: "x-layer", defillama: "xlayer" },
  "eip155:1672": { coingecko: "pharos", defillama: "pharos" },
  "eip155:5000": { coingecko: "mantle", defillama: "mantle" },
  "eip155:25": { coingecko: "cronos", defillama: "cronos" },
  "eip155:100": { coingecko: "xdai", defillama: "xdai" },
  "eip155:988": { coingecko: "stable", defillama: "stable" },
  "eip155:747474": { coingecko: "katana", defillama: "katana" },
  "eip155:80094": { coingecko: "berachain", defillama: "berachain" },
  "eip155:480": { coingecko: "world-chain", defillama: "wc" },
  "eip155:130": { coingecko: "unichain", defillama: "unichain" },
  "eip155:1329": { coingecko: "sei-v2", defillama: "sei" },
  "eip155:59144": { coingecko: "linea", defillama: "linea" },
  "eip155:42220": { coingecko: "celo", defillama: "celo" },
  "eip155:146": { coingecko: "sonic", defillama: "sonic" },
  "eip155:324": { coingecko: "zksync", defillama: "era" },
  "eip155:1868": { coingecko: "soneium", defillama: "soneium" },
  "eip155:4326": { coingecko: "megaeth", defillama: "megaeth" },
  "eip155:8217": { coingecko: "klay-token", defillama: "kaia" },
  "eip155:33139": { coingecko: "apechain", defillama: "apechain" },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": { coingecko: "solana", defillama: "solana" },
  // https://api.coingecko.com/api/v3/asset_platforms — id "tron"; DefiLlama keys tokens "tron:<base58>".
  "tron:728126428": { coingecko: "tron", defillama: "tron" },
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
