import type { AssetAmount, DisplayIntent } from "./index.ts";

/**
 * Built-in network registry: the eight original EVM mainnets, the newer EVM mainnets (DefiLlama
 * chain TVL order), the eight original testnets, the newer testnets in the same order as their
 * mainnets, then the four Bitcoin networks, the two Solana clusters and the three TRON networks.
 * Each chain id was checked against the chain's official documentation (source URL per entry) and a
 * live eth_chainId probe (2026-11-20, additions 2026-11-21). Signing-time identifiers always come
 * from this table, never from an RPC endpoint.
 */

export type NetworkMeta = {
  readonly id: string; // CAIP-2
  /** CAIP-2 family — `solana:<ref>` networks are validated against genesis-hash, not chainId. */
  readonly family: "evm" | "solana" | "bitcoin" | "tron";
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
  evm(4663, "Robinhood Chain", "ETH", false), // https://docs.robinhood.com/chain/connecting/
  evm(143, "Monad", "MON", false), // https://docs.monad.xyz/developer-essentials/network-information
  evm(5042, "Arc", "USDC", false), // https://docs.arc.network/arc/references/connect-to-arc
  evm(9745, "Plasma", "XPL", false), // https://www.plasma.org/docs/plasma-chain/network-information/connect-to-plasma
  evm(196, "X Layer", "OKB", false), // https://web3.okx.com/onchainos/dev-docs/xlayer/developer/build-on-xlayer/network-information
  evm(1672, "Pharos", "PROS", false), // https://docs.pharos.xyz/getting-started/network/pacific-mainnet
  evm(5000, "Mantle", "MNT", false), // https://docs.mantle.xyz/network/for-developers/quick-access
  evm(25, "Cronos", "CRO", false), // https://docs.cronos.com/introduction/introduction
  evm(100, "Gnosis", "xDAI", false), // https://docs.gnosischain.com/about/networks/
  evm(988, "Stable", "USDT0", false), // https://docs.stable.xyz/en/reference/mainnet-information
  evm(747474, "Katana", "ETH", false), // https://docs.katana.network/katana/technical-reference/network-information/
  evm(80094, "Berachain", "BERA", false), // https://docs.berachain.com/general/introduction/connect-to-berachain
  evm(480, "World Chain", "ETH", false), // https://docs.world.org/world-chain/quick-start/info
  evm(130, "Unichain", "ETH", false), // https://docs.unichain.org/docs/technical-information/network-information
  evm(1329, "Sei", "SEI", false), // https://docs.sei.io/evm/networks
  evm(59144, "Linea", "ETH", false), // https://docs.linea.build/get-started/build/network-info
  evm(42220, "Celo", "CELO", false), // https://docs.celo.org/network
  evm(146, "Sonic", "S", false), // https://docs.soniclabs.com/sonic/build-on-sonic/getting-started
  evm(324, "ZKsync Era", "ETH", false), // https://docs.zksync.io/zksync-network/zksync-era/network-details
  evm(1868, "Soneium", "ETH", false), // https://docs.soneium.org/docs/builders/overview
  evm(4326, "MegaETH", "ETH", false), // https://docs.megaeth.com/user-guide/connect
  evm(8217, "Kaia", "KAIA", false), // https://docs.kaia.io/references/public-en/
  evm(33139, "ApeChain", "APE", false), // https://docs.apechain.com/metamask
  evm(57073, "Ink", "ETH", false), // https://docs.inkonchain.com/general/network-information
  evm(252, "Fraxtal", "FRAX", false), // https://docs.frax.com/fraxtal/network/network-information
  evm(534352, "Scroll", "ETH", false), // https://docs.scroll.io/en/developers/
  evm(60808, "BOB", "ETH", false), // https://github.com/ethereum-optimism/superchain-registry/blob/main/chainList.json
  evm(204, "opBNB", "BNB", false), // https://docs.bnbchain.org/bnb-opbnb/get-started/network-info/
  evm(7777777, "Zora", "ETH", false), // https://github.com/ethereum-optimism/superchain-registry/blob/main/chainList.json
  evm(11155111, "Sepolia", "ETH", true), // https://ethereum.org/en/developers/docs/networks/
  evm(84532, "Base Sepolia", "ETH", true), // https://docs.base.org/docs/network-information
  evm(421614, "Arbitrum Sepolia", "ETH", true), // https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info
  evm(11155420, "OP Sepolia", "ETH", true), // https://docs.optimism.io/chain/networks
  evm(80002, "Polygon Amoy", "POL", true), // https://docs.polygon.technology/pos/reference/rpc-endpoints/
  evm(97, "BNB Smart Chain Testnet", "tBNB", true), // https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/
  evm(998, "HyperEVM Testnet", "HYPE", true), // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm
  evm(43113, "Avalanche Fuji", "AVAX", true), // https://build.avax.network/docs/tooling/rpc-providers
  evm(46630, "Robinhood Chain Testnet", "ETH", true), // https://docs.robinhood.com/chain/connecting/
  evm(10143, "Monad Testnet", "MON", true), // https://docs.monad.xyz/developer-essentials/testnet
  evm(5042002, "Arc Testnet", "USDC", true), // https://docs.arc.network/arc/references/connect-to-arc
  evm(1952, "X Layer Testnet", "OKB", true), // https://web3.okx.com/onchainos/dev-docs/xlayer/developer/build-on-xlayer/network-information
  evm(5003, "Mantle Sepolia", "MNT", true), // https://docs.mantle.xyz/network/for-developers/quick-access
  evm(10200, "Gnosis Chiado", "xDAI", true), // https://docs.gnosischain.com/about/networks/chiado
  evm(1301, "Unichain Sepolia", "ETH", true), // https://docs.unichain.org/docs/technical-information/network-information
  evm(1328, "Sei Testnet", "SEI", true), // https://docs.sei.io/evm/networks
  evm(59141, "Linea Sepolia", "ETH", true), // https://docs.linea.build/get-started/build/network-info
  evm(11142220, "Celo Sepolia", "CELO", true), // https://docs.celo.org/network
  evm(14601, "Sonic Testnet", "S", true), // https://docs.soniclabs.com/sonic/build-on-sonic/getting-started
  evm(300, "ZKsync Sepolia", "ETH", true), // https://docs.zksync.io/zksync-network/zksync-era/network-details
  evm(1946, "Soneium Minato", "ETH", true), // https://docs.soneium.org/docs/builders/overview
  evm(33111, "ApeChain Curtis", "APE", true), // https://docs.apechain.com/metamask
  evm(763373, "Ink Sepolia", "ETH", true), // https://docs.inkonchain.com/general/network-information
  evm(2523, "Fraxtal Hoodi", "FRAX", true), // https://docs.frax.com/fraxtal/network/network-information
  evm(5611, "opBNB Testnet", "tBNB", true), // https://docs.bnbchain.org/bnb-opbnb/get-started/network-info/
  evm(999999999, "Zora Sepolia", "ETH", true), // https://github.com/ethereum-optimism/superchain-registry/blob/main/chainList.json
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
  // https://github.com/ChainAgnostic/namespaces/blob/main/tron/caip2.md — decimal CAIP-2 reference
  // = genesis-block-id last 4 bytes (TIP-474); genesis block 0 via
  // POST https://api.trongrid.io/wallet/getblockbynum {"num":0}
  {
    id: "tron:728126428",
    family: "tron",
    name: "TRON",
    symbol: "TRX",
    decimals: 6,
    testnet: false,
    chainId: 728126428,
    genesisHash: "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc",
  },
  // https://github.com/ChainAgnostic/namespaces/blob/main/tron/caip2.md — genesis block 0 via
  // POST https://api.shasta.trongrid.io/wallet/getblockbynum {"num":0}
  {
    id: "tron:2494104990",
    family: "tron",
    name: "TRON Shasta",
    symbol: "TRX",
    decimals: 6,
    testnet: true,
    chainId: 2494104990,
    genesisHash: "0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e",
  },
  // https://github.com/ChainAgnostic/namespaces/blob/main/tron/caip2.md — genesis block 0 via
  // POST https://nile.trongrid.io/wallet/getblockbynum {"num":0}
  {
    id: "tron:3448148188",
    family: "tron",
    name: "TRON Nile",
    symbol: "TRX",
    decimals: 6,
    testnet: true,
    chainId: 3448148188,
    genesisHash: "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc",
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
    // Recognised typed-data content carries amounts too; the raw `data` JSON is never decorated.
    ...(i.message === undefined || i.message.kind !== "typed-data"
      ? {}
      : {
          message: {
            ...i.message,
            ...(i.message.seaport === undefined
              ? {}
              : {
                  seaport: {
                    ...i.message.seaport,
                    offer: i.message.seaport.offer.map((item) => ({
                      ...item,
                      startAmount: amount(item.startAmount),
                      endAmount: amount(item.endAmount),
                    })),
                    consideration: i.message.seaport.consideration.map((item) => ({
                      ...item,
                      startAmount: amount(item.startAmount),
                      endAmount: amount(item.endAmount),
                    })),
                  },
                }),
            ...(i.message.safe === undefined
              ? {}
              : {
                  safe: {
                    ...i.message.safe,
                    calls: i.message.safe.calls.map(decorate),
                    ...(i.message.safe.refund === undefined
                      ? {}
                      : {
                          refund: {
                            ...i.message.safe.refund,
                            gasPrice: amount(i.message.safe.refund.gasPrice),
                            amount: amount(i.message.safe.refund.amount),
                          },
                        }),
                  },
                }),
          },
        }),
  });
  return decorate(intent);
};
