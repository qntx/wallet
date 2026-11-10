import type { AssetAmount, DisplayIntent } from "./index.ts";

/**
 * Built-in network registry: the 8 mainnets from chains.mdx plus their main testnets, the four
 * Bitcoin networks and the two Solana clusters. Each chain id was checked against the chain's
 * official documentation (source URL per entry). Signing-time identifiers always come from this
 * table, never from an RPC endpoint.
 */

export type NetworkMeta = {
  readonly id: string; // CAIP-2
  /** CAIP-2 family — `solana:<ref>` networks are validated against genesis-hash, not chainId. */
  readonly family: "evm" | "solana" | "bitcoin";
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly testnet: boolean;
  readonly chainId: number;
  readonly genesisHash?: string;
};

const evm = (chainId: number, name: string, symbol: string, testnet: boolean): NetworkMeta => ({
  id: `eip155:${chainId}`,
  family: "evm",
  name,
  symbol,
  decimals: 18,
  testnet,
  chainId,
});

const EVM_NETWORKS: ReadonlyArray<NetworkMeta> = [
  // https://chainlist.org + https://ethereum.org (Ethereum mainnet chainId 1)
  evm(1, "Ethereum", "ETH", false), // https://ethereum.org/en/developers/docs/networks/
  // https://docs.base.org — Base Sepolia 84532
  evm(8453, "Base", "ETH", false), // https://docs.base.org/docs/network-information
  // https://docs.arbitrum.io — Arbitrum Sepolia 421614
  evm(42161, "Arbitrum One", "ETH", false), // https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info
  // https://docs.optimism.io — OP Sepolia 11155420
  evm(10, "OP Mainnet", "ETH", false), // https://docs.optimism.io/chain/networks
  // https://docs.polygon.technology — Amoy 80002
  evm(137, "Polygon", "POL", false), // https://docs.polygon.technology/pos/reference/rpc-endpoints/
  // https://docs.bnbchain.org — BSC testnet 97
  evm(56, "BNB Smart Chain", "BNB", false), // https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/
  // https://hyperliquid.gitbook.io — HyperEVM testnet 998
  evm(999, "HyperEVM", "HYPE", false), // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm
  // https://build.avax.network — Fuji 43113
  evm(43114, "Avalanche C-Chain", "AVAX", false), // https://build.avax.network/docs/tooling/rpc-providers
  evm(11155111, "Sepolia", "ETH", true), // https://ethereum.org/en/developers/docs/networks/
  evm(84532, "Base Sepolia", "ETH", true), // https://docs.base.org/docs/network-information
  evm(421614, "Arbitrum Sepolia", "ETH", true), // https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info
  evm(11155420, "OP Sepolia", "ETH", true), // https://docs.optimism.io/chain/networks
  evm(80002, "Polygon Amoy", "POL", true), // https://docs.polygon.technology/pos/reference/rpc-endpoints/
  evm(97, "BNB Smart Chain Testnet", "tBNB", true), // https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/
  evm(998, "HyperEVM Testnet", "HYPE", true), // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm
  evm(43113, "Avalanche Fuji", "AVAX", true), // https://build.avax.network/docs/tooling/rpc-providers
];

export const BUILT_IN_NETWORKS: ReadonlyArray<NetworkMeta> = Object.freeze([
  ...EVM_NETWORKS,
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
  {
    id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    chainId: 0,
    name: "Solana",
    symbol: "SOL",
    decimals: 9,
    testnet: false,
    family: "solana",
    // https://solana.com/docs/references/clusters (mainnet genesis hash)
    genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  },
  {
    id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    chainId: 0,
    name: "Solana Devnet",
    symbol: "SOL",
    decimals: 9,
    testnet: true,
    family: "solana",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  },
]);

export const networkMeta = (id: string): NetworkMeta | undefined =>
  BUILT_IN_NETWORKS.find((n) => n.id === id);

/**
 * Attaches `decimals` (always — a native unit's decimals are a fixed property of the family) and
 * `symbol` (when the network is in the table) to every amount of the chain's native asset inside a
 * decoded intent: outflows, minimum-received, the fee and nested batch calls.
 */
export const withNativeAmountMeta = (
  intent: DisplayIntent,
  network: string,
  asset: string,
  decimals: number,
): DisplayIntent => {
  const symbol = networkMeta(network)?.symbol;
  const amount = (a: AssetAmount): AssetAmount =>
    a.asset === asset ? { ...a, decimals, ...(symbol === undefined ? {} : { symbol }) } : a;
  const decorate = (i: DisplayIntent): DisplayIntent => ({
    ...i,
    outflows: i.outflows.map((f) => ({ ...f, amount: amount(f.amount) })),
    ...(i.minimumReceived === undefined
      ? {}
      : {
          minimumReceived: i.minimumReceived.map((m) => ({ ...m, amount: amount(m.amount) })),
        }),
    ...(i.staking === undefined
      ? {}
      : {
          staking: i.staking.map((a) =>
            a.kind === "lido-submit"
              ? { ...a, amount: amount(a.amount), receive: amount(a.receive) }
              : a,
          ),
        }),
    ...(i.fee === undefined
      ? {}
      : {
          fee: {
            ...i.fee,
            max: amount(i.fee.max),
            ...(i.fee.l1Data === undefined ? {} : { l1Data: amount(i.fee.l1Data) }),
          },
        }),
    ...(i.calls === undefined ? {} : { calls: i.calls.map(decorate) }),
  });
  return decorate(intent);
};
