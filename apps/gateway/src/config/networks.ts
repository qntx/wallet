import type { GatewayNetwork } from "../types.ts";

/**
 * Staging serves testnets only, through public keyless endpoints. Ids come from the engine's
 * network registry; `createGateway` rejects an id the registry does not know.
 */
export const STAGING_NETWORKS: ReadonlyArray<GatewayNetwork> = [
  {
    // Sepolia — chain id 0xaa36a7
    id: "eip155:11155111",
    providers: [
      // https://www.publicnode.com/ — Ethereum Sepolia public endpoint
      { id: "publicnode", url: "https://ethereum-sepolia-rpc.publicnode.com" },
      // https://docs.1rpc.io/ — 1RPC free public relay
      { id: "1rpc", url: "https://1rpc.io/sepolia" },
    ],
  },
  {
    // Base Sepolia — chain id 0x14a34
    id: "eip155:84532",
    providers: [
      // https://docs.base.org/base-chain/network-information/base-testnet — official public RPC
      { id: "base", url: "https://sepolia.base.org" },
      // https://www.publicnode.com/ — Base Sepolia public endpoint
      { id: "publicnode", url: "https://base-sepolia-rpc.publicnode.com" },
    ],
  },
  {
    // Solana devnet
    id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    providers: [
      // https://tatum.io/ — Tatum keyless public Solana devnet gateway
      { id: "tatum", url: "https://solana-devnet.gateway.tatum.io" },
      // https://www.onfinality.io/ — OnFinality public Solana devnet endpoint
      { id: "onfinality", url: "https://solana-devnet.api.onfinality.io/public" },
    ],
  },
  {
    // Bitcoin signet (Esplora)
    id: "bip122:00000008819873e925422c1ff0f99f7c",
    providers: [
      // https://github.com/Blockstream/esplora/blob/master/API.md — Blockstream signet API
      { id: "blockstream", url: "https://blockstream.info/signet/api" },
      // https://mempool.emzy.de/ — community mempool.space instance (Esplora-compatible subset)
      { id: "emzy", url: "https://mempool.emzy.de/signet/api" },
    ],
  },
  {
    // Bitcoin testnet4 (Esplora)
    id: "bip122:00000000da84f2bafbbc53dee25a72ae",
    providers: [
      // https://github.com/Blockstream/esplora/blob/master/API.md — Blockstream testnet4 API
      { id: "blockstream", url: "https://blockstream.info/testnet4/api" },
      // https://mempool.emzy.de/ — community mempool.space instance (Esplora-compatible subset)
      { id: "emzy", url: "https://mempool.emzy.de/testnet4/api" },
    ],
  },
];

/**
 * Production serves mainnets only. EVM and Solana prefer Alchemy, falling back to dRPC; Bitcoin
 * uses Blockstream Enterprise's Esplora (the engine falls back to the host's own endpoints on a
 * 503). Keys ride in headers — URLs carry no key material.
 */
export const PRODUCTION_NETWORKS: ReadonlyArray<GatewayNetwork> = [
  {
    // Ethereum mainnet — chain id 1
    id: "eip155:1",
    providers: [
      // https://docs.alchemy.com/reference/evm-quickstart — JSON-RPC over bearer auth
      { id: "alchemy", url: "https://eth-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      // https://drpc.org/docs — load balancer, key in the Drpc-Key header
      { id: "drpc", url: "https://lb.drpc.live/ethereum", auth: "drpc" },
    ],
  },
  {
    // Base — chain id 8453
    id: "eip155:8453",
    providers: [
      { id: "alchemy", url: "https://base-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/base", auth: "drpc" },
    ],
  },
  {
    // Arbitrum One — chain id 42161
    id: "eip155:42161",
    providers: [
      { id: "alchemy", url: "https://arb-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/arbitrum", auth: "drpc" },
    ],
  },
  {
    // OP Mainnet — chain id 10
    id: "eip155:10",
    providers: [
      { id: "alchemy", url: "https://opt-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/optimism", auth: "drpc" },
    ],
  },
  {
    // Polygon — chain id 137
    id: "eip155:137",
    providers: [
      { id: "alchemy", url: "https://polygon-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/polygon", auth: "drpc" },
    ],
  },
  {
    // BNB Smart Chain — chain id 56
    id: "eip155:56",
    providers: [
      { id: "alchemy", url: "https://bnb-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/bsc", auth: "drpc" },
    ],
  },
  {
    // HyperEVM — chain id 999
    id: "eip155:999",
    providers: [
      { id: "alchemy", url: "https://hyperliquid-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/hyperliquid", auth: "drpc" },
    ],
  },
  {
    // Avalanche C-Chain — chain id 43114
    id: "eip155:43114",
    providers: [
      { id: "alchemy", url: "https://avax-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/avalanche", auth: "drpc" },
    ],
  },
  {
    // Solana mainnet-beta
    id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    providers: [
      // https://docs.alchemy.com/reference/solana-quickstart — JSON-RPC over bearer auth
      { id: "alchemy", url: "https://solana-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/solana", auth: "drpc" },
    ],
  },
  {
    // Bitcoin mainnet (Esplora)
    id: "bip122:000000000019d6689c085ae165831e93",
    providers: [
      // https://github.com/Blockstream/esplora/blob/master/API.md + Enterprise OAuth —
      // token from login.blockstream.com client_credentials, sent as bearer
      {
        id: "blockstream",
        url: "https://enterprise.blockstream.info/api",
        auth: "blockstream",
      },
    ],
  },
];
