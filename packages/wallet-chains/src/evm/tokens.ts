/**
 * Built-in ERC-20 token table, keyed by `chainId` then checksummed address. An entry here makes an
 * ERC-20 `transfer` `full`-verifiable (WD-065), so every entry must come from the issuer's own
 * published list and be reviewed against it; the source is recorded per issuer below.
 */

export type EvmToken = {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
};

export type EvmTokenTable = Readonly<Record<string, Readonly<Record<string, EvmToken>>>>;

// Circle USDC (native issuance, 6 decimals), from
// https://developers.circle.com/stablecoins/usdc-contract-addresses (reviewed 2026-11-20/21). BNB
// Chain has no Circle-issued USDC (the Binance-pegged token is a different issuer), so it is
// absent. Arc's USDC at 0x3600…0000 is the native coin's ERC-20 view — listing it would double
// count the native balance — and the other chains on Circle's list (Scroll, …) are not built-in
// networks.
const USDC: EvmToken = Object.freeze({ symbol: "USDC", decimals: 6, name: "USD Coin" });

// Tether USDT (6 decimals), from https://tether.to/en/supported-protocols/ (reviewed 2026-11-20):
// Tether lists USD₮ on Ethereum, Avalanche, Celo and Kaia among our networks; USDT0 and bridged or
// third-party USDT on other chains are different issuers and are absent.
const USDT: EvmToken = Object.freeze({ symbol: "USDT", decimals: 6, name: "Tether USD" });

/** The built-in table. */
export const evmTokenTable: EvmTokenTable = Object.freeze({
  "1": Object.freeze({
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": USDC,
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": USDT,
  }),
  "10": Object.freeze({ "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85": USDC }),
  "25": Object.freeze({ "0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D": USDC }),
  "130": Object.freeze({ "0x078D782b760474a361dDA0AF3839290b0EF57AD6": USDC }),
  "137": Object.freeze({ "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": USDC }),
  "143": Object.freeze({ "0x754704Bc059F8C67012fEd69BC8A327a5aafb603": USDC }),
  "146": Object.freeze({ "0x29219dd400f2Bf60E5a23d13Be72B486D4038894": USDC }),
  "196": Object.freeze({ "0xB6CEceAB302E2E4948951eE7843FC24E92933061": USDC }),
  "324": Object.freeze({ "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4": USDC }),
  // Circle's page prints a non-EIP-55 casing; this is the checksummed form.
  "480": Object.freeze({ "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1": USDC }),
  "999": Object.freeze({ "0xb88339CB7199b77E23DB6E890353E22632Ba630f": USDC }),
  "1329": Object.freeze({ "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392": USDC }),
  "1672": Object.freeze({ "0xC879C018dB60520F4355C26eD1a6D572cdAC1815": USDC }),
  "8217": Object.freeze({ "0xd077A400968890Eacc75cdc901F0356c943e4fDb": USDT }),
  "8453": Object.freeze({ "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": USDC }),
  "9745": Object.freeze({ "0x2d661C89D812261039AF9764eceaAee884f5F67F": USDC }),
  "42161": Object.freeze({ "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": USDC }),
  "42220": Object.freeze({
    "0xcebA9300f2b948710d2653dD7B07f33A8B32118C": USDC,
    "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e": USDT,
  }),
  "43114": Object.freeze({
    "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E": USDC,
    "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7": USDT,
  }),
  "57073": Object.freeze({ "0x2D270e6886d130D724215A266106e6832161EAEd": USDC }),
  "59144": Object.freeze({ "0x176211869cA2b568f2A7D4EE941E073a821EE1ff": USDC }),
});

export const lookupEvmToken = (
  table: EvmTokenTable,
  chainId: number,
  address: string,
): EvmToken | undefined => table[String(chainId)]?.[address];
