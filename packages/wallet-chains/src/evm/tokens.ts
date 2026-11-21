/**
 * Built-in ERC-20 token table, keyed by `chainId` then checksummed address. An entry here makes an
 * ERC-20 `transfer` `full`-verifiable (WD-065), so every entry must come from the issuer's own
 * published list and be reviewed against it; the source is recorded per issuer below.
 */

export type EvmToken = {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
  /**
   * "native-alias": an ERC-20 view that moves the chain's native balance — its calls are described
   * like any listed token's, but it is never counted as a separate balance nor offered by
   * discovery. "wrapped-native": a WETH9-style deposit/withdraw contract.
   */
  readonly role?: "native-alias" | "wrapped-native";
};

export type EvmTokenTable = Readonly<Record<string, Readonly<Record<string, EvmToken>>>>;

// Circle USDC (native issuance, 6 decimals), from
// https://developers.circle.com/stablecoins/usdc-contract-addresses (reviewed 2026-11-20/21). BNB
// Chain has no Circle-issued USDC (the Binance-pegged token is a different issuer), so it is
// absent. Arc's USDC at 0x3600…0000 is the native coin's ERC-20 view — listed below as a native
// alias rather than a Circle issuance — and Scroll on Circle's list is a different deployment.
const USDC: EvmToken = Object.freeze({ symbol: "USDC", decimals: 6, name: "USD Coin" });

// Tether USDT (6 decimals), from https://tether.to/en/supported-protocols/ (reviewed 2026-11-20):
// Tether lists USD₮ on Ethereum, Avalanche, Celo and Kaia among our networks; USDT0 and bridged or
// third-party USDT on other chains are different issuers and are absent.
const USDT: EvmToken = Object.freeze({ symbol: "USDT", decimals: 6, name: "Tether USD" });

// Native aliases — an ERC-20 front for the chain's own coin; balanceOf mirrors the native
// balance, checked live 2026-11-21.
// https://docs.celo.org/contracts/core-contracts (GoldToken/CeloToken).
const CELO_ALIAS: EvmToken = Object.freeze({
  symbol: "CELO",
  decimals: 18,
  name: "Celo native asset",
  role: "native-alias",
});
// https://docs.arc.network/arc/references/contract-addresses.
const ARC_USDC_ALIAS: EvmToken = Object.freeze({
  symbol: "USDC",
  decimals: 6,
  name: "USDC",
  role: "native-alias",
});

// Wrapped natives — WETH9-style deposit/withdraw contracts; their deposit()/withdraw(uint256)
// calls describe as a swap between the coin and the token.
const WETH: EvmToken = Object.freeze({
  symbol: "WETH",
  decimals: 18,
  name: "Wrapped Ether",
  role: "wrapped-native",
});
const WBNB: EvmToken = Object.freeze({
  symbol: "WBNB",
  decimals: 18,
  name: "Wrapped BNB",
  role: "wrapped-native",
});

// Rows marked "// OP Stack" hold the same WETH predeploy every OP Stack chain deploys —
// https://specs.optimism.io/protocol/predeploys.html.

/** The built-in table. */
export const evmTokenTable: EvmTokenTable = Object.freeze({
  "1": Object.freeze({
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": USDC,
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": USDT,
    // https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": WETH,
  }),
  "10": Object.freeze({
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85": USDC,
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "25": Object.freeze({
    "0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D": USDC,
    // https://docs.cronos.org/for-dapp-developers/cronos-smart-contract/token-contract-addresses
    "0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23": Object.freeze({
      symbol: "WCRO",
      decimals: 18,
      name: "Wrapped CRO",
      role: "wrapped-native",
    }),
  }),
  "56": Object.freeze({
    // https://docs.uniswap.org/contracts/v3/reference/deployments/bnb-deployments
    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c": WBNB,
  }),
  "130": Object.freeze({
    "0x078D782b760474a361dDA0AF3839290b0EF57AD6": USDC,
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "137": Object.freeze({
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": USDC,
    // https://docs.uniswap.org/contracts/v3/reference/deployments/polygon-deployments
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": Object.freeze({
      symbol: "WPOL",
      decimals: 18,
      name: "Wrapped Polygon Ecosystem Token",
      role: "wrapped-native",
    }),
  }),
  "143": Object.freeze({
    "0x754704Bc059F8C67012fEd69BC8A327a5aafb603": USDC,
    // https://docs.monad.xyz/developer-essentials/network-information
    "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A": Object.freeze({
      symbol: "WMON",
      decimals: 18,
      name: "Wrapped MON",
      role: "wrapped-native",
    }),
  }),
  "146": Object.freeze({
    "0x29219dd400f2Bf60E5a23d13Be72B486D4038894": USDC,
    // https://docs.soniclabs.com/sonic/build-on-sonic/contract-addresses
    "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38": Object.freeze({
      symbol: "wS",
      decimals: 18,
      name: "Wrapped Sonic",
      role: "wrapped-native",
    }),
  }),
  "196": Object.freeze({ "0xB6CEceAB302E2E4948951eE7843FC24E92933061": USDC }),
  "204": Object.freeze({
    // https://docs.bnbchain.org/bnb-opbnb/core-concepts/opbnb-protocol-addresses/
    "0x4200000000000000000000000000000000000006": WBNB,
  }),
  "324": Object.freeze({ "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4": USDC }),
  // Circle's page prints a non-EIP-55 casing; this is the checksummed form.
  "480": Object.freeze({
    "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1": USDC,
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  // https://docs.stable.xyz/en/explanation/usdt0-behavior — balanceOf mirrors the native balance,
  // checked live 2026-11-21.
  "988": Object.freeze({
    "0x779Ded0c9e1022225f8E0630b35a9b54bE713736": Object.freeze({
      symbol: "USDT0",
      decimals: 6,
      name: "USDT0",
      role: "native-alias",
    }),
  }),
  "999": Object.freeze({
    "0xb88339CB7199b77E23DB6E890353E22632Ba630f": USDC,
    // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/wrapped-hype
    "0x5555555555555555555555555555555555555555": Object.freeze({
      symbol: "WHYPE",
      decimals: 18,
      name: "Wrapped HYPE",
      role: "wrapped-native",
    }),
  }),
  "1329": Object.freeze({
    "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392": USDC,
    // https://docs.sei.io/evm/ecosystem-contracts
    "0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7": Object.freeze({
      symbol: "WSEI",
      decimals: 18,
      name: "Wrapped SEI",
      role: "wrapped-native",
    }),
  }),
  "1672": Object.freeze({ "0xC879C018dB60520F4355C26eD1a6D572cdAC1815": USDC }),
  "1868": Object.freeze({
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "4326": Object.freeze({
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "5042": Object.freeze({ "0x3600000000000000000000000000000000000000": ARC_USDC_ALIAS }),
  "8217": Object.freeze({
    "0xd077A400968890Eacc75cdc901F0356c943e4fDb": USDT,
    // https://docs.kaia.io/references/contract-addresses/
    "0x19Aac5f612f524B754CA7e7c41cbFa2E981A4432": Object.freeze({
      symbol: "WKLAY",
      decimals: 18,
      name: "Wrapped Klay",
      role: "wrapped-native",
    }),
  }),
  "8453": Object.freeze({
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": USDC,
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "9745": Object.freeze({ "0x2d661C89D812261039AF9764eceaAee884f5F67F": USDC }),
  "42161": Object.freeze({
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": USDC,
    // https://docs.arbitrum.io/for-devs/useful-addresses
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": WETH,
  }),
  "42220": Object.freeze({
    "0xcebA9300f2b948710d2653dD7B07f33A8B32118C": USDC,
    "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e": USDT,
    "0x471EcE3750Da237f93B8E339c536989b8978a438": CELO_ALIAS,
  }),
  "43114": Object.freeze({
    "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E": USDC,
    "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7": USDT,
    // https://docs.uniswap.org/contracts/v3/reference/deployments/avax-deployments
    "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7": Object.freeze({
      symbol: "WAVAX",
      decimals: 18,
      name: "Wrapped AVAX",
      role: "wrapped-native",
    }),
  }),
  "57073": Object.freeze({
    "0x2D270e6886d130D724215A266106e6832161EAEd": USDC,
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "59144": Object.freeze({ "0x176211869cA2b568f2A7D4EE941E073a821EE1ff": USDC }),
  "60808": Object.freeze({
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "80094": Object.freeze({
    // https://docs.berachain.com/developers/deployed-contracts
    "0x6969696969696969696969696969696969696969": Object.freeze({
      symbol: "WBERA",
      decimals: 18,
      name: "Wrapped Bera",
      role: "wrapped-native",
    }),
  }),
  "534352": Object.freeze({
    // https://docs.scroll.io/en/developers/scroll-contracts
    "0x5300000000000000000000000000000000000004": WETH,
  }),
  "747474": Object.freeze({
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "5042002": Object.freeze({ "0x3600000000000000000000000000000000000000": ARC_USDC_ALIAS }),
  "7777777": Object.freeze({
    "0x4200000000000000000000000000000000000006": WETH, // OP Stack
  }),
  "11142220": Object.freeze({
    "0x471EcE3750Da237f93B8E339c536989b8978a438": CELO_ALIAS,
  }),
});

export const lookupEvmToken = (
  table: EvmTokenTable,
  chainId: number,
  address: string,
): EvmToken | undefined => table[String(chainId)]?.[address];
