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
