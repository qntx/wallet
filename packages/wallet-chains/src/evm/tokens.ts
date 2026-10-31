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
// https://developers.circle.com/stablecoins/usdc-contract-addresses (reviewed 2026-10-30). BNB
// Chain has no Circle-issued USDC (the Binance-pegged token is a different issuer), so it is absent.
const USDC: EvmToken = Object.freeze({ symbol: "USDC", decimals: 6, name: "USD Coin" });

// Tether USDT (6 decimals), from https://tether.to/en/supported-protocols/ (reviewed 2026-10-31):
// Tether lists USD₮ on Ethereum and Avalanche among our networks; bridged or third-party USDT on
// other chains is a different issuer and is absent.
const USDT: EvmToken = Object.freeze({ symbol: "USDT", decimals: 6, name: "Tether USD" });

/** The built-in table. */
export const evmTokenTable: EvmTokenTable = Object.freeze({
  "1": Object.freeze({
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": USDC,
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": USDT,
  }),
  "10": Object.freeze({ "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85": USDC }),
  "137": Object.freeze({ "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": USDC }),
  "999": Object.freeze({ "0xb88339CB7199b77E23DB6E890353E22632Ba630f": USDC }),
  "8453": Object.freeze({ "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": USDC }),
  "42161": Object.freeze({ "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": USDC }),
  "43114": Object.freeze({
    "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E": USDC,
    "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7": USDT,
  }),
});

export const lookupEvmToken = (
  table: EvmTokenTable,
  chainId: number,
  address: string,
): EvmToken | undefined => table[String(chainId)]?.[address];
