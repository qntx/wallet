/**
 * Built-in EVM network registry: the 8 mainnets from chains.mdx plus their main testnets. Each
 * chain id was checked against the chain's official documentation (source URL per entry).
 * Signing-time chainId always comes from this table, never from an RPC endpoint.
 */

export type NetworkInfo = {
  readonly id: string; // CAIP-2 eip155:<chainId>
  readonly chainId: number;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly testnet: boolean;
};

const entry = (
  chainId: number,
  name: string,
  symbol: string,
  testnet: boolean,
  _source: string,
): NetworkInfo => ({ id: `eip155:${chainId}`, chainId, name, symbol, decimals: 18, testnet });

export const NETWORKS: ReadonlyArray<NetworkInfo> = [
  // https://chainlist.org + https://ethereum.org (Ethereum mainnet chainId 1)
  entry(1, "Ethereum", "ETH", false, "https://ethereum.org/en/developers/docs/networks/"),
  // https://docs.base.org — Base Sepolia 84532
  entry(8453, "Base", "ETH", false, "https://docs.base.org/docs/network-information"),
  // https://docs.arbitrum.io — Arbitrum Sepolia 421614
  entry(
    42161,
    "Arbitrum One",
    "ETH",
    false,
    "https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info",
  ),
  // https://docs.optimism.io — OP Sepolia 11155420
  entry(10, "OP Mainnet", "ETH", false, "https://docs.optimism.io/chain/networks"),
  // https://docs.polygon.technology — Amoy 80002
  entry(
    137,
    "Polygon",
    "POL",
    false,
    "https://docs.polygon.technology/pos/reference/rpc-endpoints/",
  ),
  // https://docs.bnbchain.org — BSC testnet 97
  entry(
    56,
    "BNB Smart Chain",
    "BNB",
    false,
    "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/",
  ),
  // https://hyperliquid.gitbook.io — HyperEVM testnet 998
  entry(
    999,
    "HyperEVM",
    "HYPE",
    false,
    "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm",
  ),
  // https://build.avax.network — Fuji 43113
  entry(
    43114,
    "Avalanche C-Chain",
    "AVAX",
    false,
    "https://build.avax.network/docs/tooling/rpc-providers",
  ),
  entry(11155111, "Sepolia", "ETH", true, "https://ethereum.org/en/developers/docs/networks/"),
  entry(84532, "Base Sepolia", "ETH", true, "https://docs.base.org/docs/network-information"),
  entry(
    421614,
    "Arbitrum Sepolia",
    "ETH",
    true,
    "https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info",
  ),
  entry(11155420, "OP Sepolia", "ETH", true, "https://docs.optimism.io/chain/networks"),
  entry(
    80002,
    "Polygon Amoy",
    "POL",
    true,
    "https://docs.polygon.technology/pos/reference/rpc-endpoints/",
  ),
  entry(
    97,
    "BNB Smart Chain Testnet",
    "tBNB",
    true,
    "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/",
  ),
  entry(
    998,
    "HyperEVM Testnet",
    "HYPE",
    true,
    "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm",
  ),
  entry(
    43113,
    "Avalanche Fuji",
    "AVAX",
    true,
    "https://build.avax.network/docs/tooling/rpc-providers",
  ),
];

export const networkById = (id: string): NetworkInfo | undefined =>
  NETWORKS.find((n) => n.id === id);
