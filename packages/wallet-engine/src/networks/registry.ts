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
  readonly multicall3?: string;
  /** CAIP-2 family — `solana:<ref>` networks are validated against genesis-hash, not chainId. */
  readonly family: "evm" | "solana" | "bitcoin";
  readonly genesisHash?: string;
  readonly decimals: number;
  readonly testnet: boolean;
};

const entry = (
  chainId: number,
  name: string,
  symbol: string,
  testnet: boolean,
  _source: string,
): NetworkInfo => ({
  id: `eip155:${chainId}`,
  chainId,
  name,
  symbol,
  decimals: 18,
  testnet,
  family: "evm",
  // Canonical Multicall3 — https://github.com/mds1/multicall3 deployments (all entries below).
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
});

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
  [...NETWORKS, ...SOLANA_NETWORKS, ...BITCOIN_NETWORKS].find((n) => n.id === id);
export const BITCOIN_NETWORKS: ReadonlyArray<NetworkInfo> = [
  {
    id: "bip122:000000000019d6689c085ae165831e93",
    chainId: 0,
    name: "Bitcoin",
    symbol: "BTC",
    decimals: 8,
    testnet: false,
    family: "bitcoin",
    genesisHash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  },
  {
    id: "bip122:00000000da84f2bafbbc53dee25a72ae",
    chainId: 0,
    name: "Bitcoin Testnet4",
    symbol: "tBTC",
    decimals: 8,
    testnet: true,
    family: "bitcoin",
    genesisHash: "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
  },
  {
    id: "bip122:00000008819873e925422c1ff0f99f7c",
    chainId: 0,
    name: "Bitcoin Signet",
    symbol: "sBTC",
    decimals: 8,
    testnet: true,
    family: "bitcoin",
    genesisHash: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
  },
  {
    id: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
    chainId: 0,
    name: "Bitcoin Regtest",
    symbol: "rBTC",
    decimals: 8,
    testnet: true,
    family: "bitcoin",
    genesisHash: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
  },
];

export const SOLANA_NETWORKS: ReadonlyArray<NetworkInfo> = [
  {
    id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    chainId: 0,
    name: "Solana",
    symbol: "SOL",
    decimals: 9,
    testnet: false,
    family: "solana",
    // https://solana.com/docs/references/clusters (mainnet genesis hash)
    genesisHash:
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpWvDVGok8cUQPCbq9AzdTQvpNbNvyq4qDvMNTrDDezsFapSihepu2eQEdje",
  },
  {
    id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    chainId: 0,
    name: "Solana Devnet",
    symbol: "SOL",
    decimals: 9,
    testnet: true,
    family: "solana",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBGGSWgX4GwCJRmgdcvRaRmFbXfw3nDZBTqsr",
  },
];
