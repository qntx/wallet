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
    // Arbitrum Sepolia — chain id 421614
    id: "eip155:421614",
    providers: [
      // https://www.publicnode.com/ — Arbitrum Sepolia public endpoint
      { id: "publicnode", url: "https://arbitrum-sepolia-rpc.publicnode.com" },
      // https://zan.top/ — ZAN public endpoint
      { id: "zan", url: "https://api.zan.top/arb-sepolia" },
    ],
  },
  {
    // OP Sepolia — chain id 11155420
    id: "eip155:11155420",
    providers: [
      // https://zan.top/ — ZAN public endpoint
      { id: "zan", url: "https://api.zan.top/opt-sepolia" },
      // https://nodies.app/ — Nodies public endpoint
      { id: "nodies", url: "https://optimism-sepolia-public.nodies.app" },
    ],
  },
  {
    // Polygon Amoy — chain id 80002
    id: "eip155:80002",
    providers: [
      // https://www.publicnode.com/ — Polygon Amoy public endpoint
      { id: "publicnode", url: "https://polygon-amoy-bor-rpc.publicnode.com" },
      // https://zan.top/ — ZAN public endpoint
      { id: "zan", url: "https://api.zan.top/polygon-amoy" },
    ],
  },
  {
    // BNB Smart Chain Testnet — chain id 97
    id: "eip155:97",
    providers: [
      // https://www.publicnode.com/ — BSC testnet public endpoint
      { id: "publicnode", url: "https://bsc-testnet-rpc.publicnode.com" },
      // https://zan.top/ — ZAN public endpoint
      { id: "zan", url: "https://api.zan.top/bsc-testnet" },
    ],
  },
  {
    // HyperEVM Testnet — chain id 998
    id: "eip155:998",
    providers: [
      // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm — official testnet RPC
      { id: "hyperliquid", url: "https://rpc.hyperliquid-testnet.xyz/evm" },
      // https://rpcs.chain.link/ — Chainlink public RPC
      { id: "chainlink", url: "https://rpcs.chain.link/hyperevm/testnet" },
    ],
  },
  {
    // Avalanche Fuji — chain id 43113
    id: "eip155:43113",
    providers: [
      // https://build.avax.network/docs/tooling/rpc-providers — official Fuji C-Chain RPC
      { id: "avalanche", url: "https://api.avax-test.network/ext/bc/C/rpc" },
      // https://www.publicnode.com/ — Fuji public endpoint
      { id: "publicnode", url: "https://avalanche-fuji-c-chain-rpc.publicnode.com" },
    ],
  },
  {
    // Robinhood Chain Testnet — chain id 46630
    id: "eip155:46630",
    providers: [
      // https://docs.robinhood.com/chain/deploy-smart-contracts/ — official testnet RPC
      { id: "robinhood", url: "https://rpc.testnet.chain.robinhood.com" },
      // https://www.publicnode.com/ — Robinhood Chain testnet public endpoint
      { id: "publicnode", url: "https://robinhood-sepolia-rpc.publicnode.com" },
    ],
  },
  {
    // Monad Testnet — chain id 10143
    id: "eip155:10143",
    providers: [
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://monad-testnet.drpc.org" },
      // https://www.onfinality.io/ — OnFinality public endpoint
      { id: "onfinality", url: "https://monad-testnet.api.onfinality.io/public" },
    ],
  },
  {
    // Arc Testnet — chain id 5042002
    id: "eip155:5042002",
    providers: [
      // https://docs.arc.network/ — official testnet RPC
      { id: "arc", url: "https://rpc.testnet.arc.network" },
      // https://www.publicnode.com/ — Arc testnet public endpoint
      { id: "publicnode", url: "https://arc-testnet-rpc.publicnode.com" },
    ],
  },
  {
    // X Layer Testnet — chain id 1952
    id: "eip155:1952",
    providers: [
      // https://web3.okx.com/onchainos/dev-docs/xlayer/developer/rpc-endpoints/rpc-endpoints — official testnet RPC
      { id: "xlayer", url: "https://testrpc.xlayer.tech" },
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://xlayer-testnet.drpc.org" },
    ],
  },
  {
    // Mantle Sepolia — chain id 5003
    id: "eip155:5003",
    providers: [
      // https://docs.mantle.xyz/network/for-developers/quick-access — official Sepolia RPC
      { id: "mantle", url: "https://rpc.sepolia.mantle.xyz" },
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://mantle-sepolia.drpc.org" },
    ],
  },
  {
    // Gnosis Chiado — chain id 10200
    id: "eip155:10200",
    providers: [
      // https://docs.gnosischain.com/about/networks/chiado — documented archive RPC
      { id: "gateway-fm", url: "https://rpc.chiado.gnosis.gateway.fm" },
      // https://www.publicnode.com/ — Chiado public endpoint
      { id: "publicnode", url: "https://gnosis-chiado-rpc.publicnode.com" },
    ],
  },
  {
    // Unichain Sepolia — chain id 1301
    id: "eip155:1301",
    providers: [
      // https://docs.unichain.org/docs/technical-information/network-information — official Sepolia RPC
      { id: "unichain", url: "https://sepolia.unichain.org" },
      // https://www.publicnode.com/ — Unichain Sepolia public endpoint
      { id: "publicnode", url: "https://unichain-sepolia-rpc.publicnode.com" },
    ],
  },
  {
    // Sei Testnet — chain id 1328
    id: "eip155:1328",
    providers: [
      // https://docs.sei.io/evm/networks — official testnet EVM RPC
      { id: "sei", url: "https://evm-rpc-testnet.sei-apis.com" },
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://sei-testnet.drpc.org" },
    ],
  },
  {
    // Linea Sepolia — chain id 59141
    id: "eip155:59141",
    providers: [
      // https://docs.linea.build/get-started/build/network-info — official Sepolia RPC
      { id: "linea", url: "https://rpc.sepolia.linea.build" },
      // https://www.publicnode.com/ — Linea Sepolia public endpoint
      { id: "publicnode", url: "https://linea-sepolia-rpc.publicnode.com" },
    ],
  },
  {
    // Celo Sepolia — chain id 11142220
    id: "eip155:11142220",
    providers: [
      // https://docs.celo.org/network — official Forno endpoint
      { id: "celo", url: "https://forno.celo-sepolia.celo-testnet.org" },
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://celo-sepolia.drpc.org" },
    ],
  },
  {
    // Sonic Testnet — chain id 14601
    id: "eip155:14601",
    providers: [
      // https://docs.soniclabs.com/sonic/build-on-sonic/getting-started — official testnet RPC
      { id: "sonic", url: "https://rpc.testnet.soniclabs.com" },
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://sonic-testnet-v2.drpc.org" },
    ],
  },
  {
    // ZKsync Sepolia — chain id 300
    id: "eip155:300",
    providers: [
      // https://docs.zksync.io/zksync-network/zksync-era/network-details — official Sepolia RPC
      { id: "zksync", url: "https://sepolia.era.zksync.dev" },
      // https://www.onfinality.io/ — OnFinality public endpoint
      { id: "onfinality", url: "https://zksync-sepolia.api.onfinality.io/public" },
    ],
  },
  {
    // Soneium Minato — chain id 1946
    id: "eip155:1946",
    providers: [
      // https://docs.soneium.org/docs/builders/overview — official Minato RPC
      { id: "soneium", url: "https://rpc.minato.soneium.org" },
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://soneium-minato.drpc.org" },
    ],
  },
  {
    // ApeChain Curtis — chain id 33111
    id: "eip155:33111",
    providers: [
      // https://docs.apechain.com/metamask — official Curtis RPC
      { id: "apechain", url: "https://rpc.curtis.apechain.com" },
      // https://drpc.org/ — keyless public endpoint
      { id: "drpc", url: "https://apechain-curtis.drpc.org" },
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
  {
    // TRON Nile — https://developers.tron.network/docs/networks
    id: "tron:3448148188",
    providers: [
      // https://developers.tron.network/docs/networks — TronGrid Nile, keyless
      { id: "trongrid", url: "https://nile.trongrid.io" },
      // https://nileex.io — Nile public node, keyless
      { id: "nileex", url: "https://api.nileex.io" },
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
    // Robinhood Chain — chain id 4663
    id: "eip155:4663",
    providers: [
      { id: "alchemy", url: "https://robinhood-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/robinhood", auth: "drpc" },
    ],
  },
  {
    // Monad — chain id 143
    id: "eip155:143",
    providers: [
      { id: "alchemy", url: "https://monad-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/monad-mainnet", auth: "drpc" },
    ],
  },
  {
    // Arc — chain id 5042
    id: "eip155:5042",
    providers: [
      { id: "alchemy", url: "https://arc-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/arc", auth: "drpc" },
    ],
  },
  {
    // Plasma — chain id 9745
    id: "eip155:9745",
    providers: [
      { id: "alchemy", url: "https://plasma-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/plasma", auth: "drpc" },
    ],
  },
  {
    // X Layer — chain id 196
    id: "eip155:196",
    providers: [
      { id: "alchemy", url: "https://xlayer-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/xlayer", auth: "drpc" },
    ],
  },
  {
    // Pharos — chain id 1672
    id: "eip155:1672",
    providers: [
      { id: "alchemy", url: "https://pharos-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/pharos", auth: "drpc" },
    ],
  },
  {
    // Mantle — chain id 5000
    id: "eip155:5000",
    providers: [
      { id: "alchemy", url: "https://mantle-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/mantle", auth: "drpc" },
    ],
  },
  {
    // Cronos — chain id 25
    id: "eip155:25",
    providers: [
      { id: "alchemy", url: "https://cronos-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/cronos", auth: "drpc" },
    ],
  },
  {
    // Gnosis — chain id 100
    id: "eip155:100",
    providers: [
      { id: "alchemy", url: "https://gnosis-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/gnosis", auth: "drpc" },
    ],
  },
  {
    // Stable — chain id 988
    id: "eip155:988",
    providers: [
      { id: "alchemy", url: "https://stable-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/stable", auth: "drpc" },
    ],
  },
  {
    // Katana — chain id 747474
    id: "eip155:747474",
    providers: [
      { id: "alchemy", url: "https://katana-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/katana", auth: "drpc" },
    ],
  },
  {
    // Berachain — chain id 80094
    id: "eip155:80094",
    providers: [
      { id: "alchemy", url: "https://berachain-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/berachain", auth: "drpc" },
    ],
  },
  {
    // World Chain — chain id 480
    id: "eip155:480",
    providers: [
      { id: "alchemy", url: "https://worldchain-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/worldchain", auth: "drpc" },
    ],
  },
  {
    // Unichain — chain id 130
    id: "eip155:130",
    providers: [
      { id: "alchemy", url: "https://unichain-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/unichain", auth: "drpc" },
    ],
  },
  {
    // Sei — chain id 1329
    id: "eip155:1329",
    providers: [
      { id: "alchemy", url: "https://sei-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/sei", auth: "drpc" },
    ],
  },
  {
    // Linea — chain id 59144
    id: "eip155:59144",
    providers: [
      { id: "alchemy", url: "https://linea-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/linea", auth: "drpc" },
    ],
  },
  {
    // Celo — chain id 42220
    id: "eip155:42220",
    providers: [
      { id: "alchemy", url: "https://celo-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/celo", auth: "drpc" },
    ],
  },
  {
    // Sonic — chain id 146
    id: "eip155:146",
    providers: [
      { id: "alchemy", url: "https://sonic-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/sonic", auth: "drpc" },
    ],
  },
  {
    // ZKsync Era — chain id 324
    id: "eip155:324",
    providers: [
      { id: "alchemy", url: "https://zksync-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/zksync", auth: "drpc" },
    ],
  },
  {
    // Soneium — chain id 1868
    id: "eip155:1868",
    providers: [
      { id: "alchemy", url: "https://soneium-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/soneium", auth: "drpc" },
    ],
  },
  {
    // MegaETH — chain id 4326
    id: "eip155:4326",
    providers: [
      { id: "alchemy", url: "https://megaeth-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/megaeth", auth: "drpc" },
    ],
  },
  {
    // Kaia — chain id 8217
    id: "eip155:8217",
    providers: [
      { id: "alchemy", url: "https://kaia-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/klaytn", auth: "drpc" },
    ],
  },
  {
    // ApeChain — chain id 33139
    id: "eip155:33139",
    providers: [
      { id: "alchemy", url: "https://apechain-mainnet.g.alchemy.com/v2", auth: "alchemy" },
      { id: "drpc", url: "https://lb.drpc.live/apechain", auth: "drpc" },
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
  {
    // TRON mainnet — https://developers.tron.network/docs/networks
    id: "tron:728126428",
    providers: [
      // https://www.trongrid.io — key in the TRON-PRO-API-KEY header
      { id: "trongrid", url: "https://api.trongrid.io", auth: "trongrid" },
      // https://docs.tatum.io/reference/rpc-tron-restapi — node API base, key in the x-api-key
      // header
      { id: "tatum", url: "https://tron-mainnet.gateway.tatum.io", auth: "tatum" },
    ],
  },
];
