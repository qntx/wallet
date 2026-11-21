/**
 * Built-in TRC-20 token table, keyed by `network` then base58 address. An entry makes a TRC-20
 * `transfer` `full`-verifiable, so every entry is a tronscan verified token (vip, level "2") or
 * issuer-listed, with on-chain `decimals()` confirmed — sources recorded per entry, reviewed
 * 2026-11-20. TRON has no USDC entry: `TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8` is flagged "USDCOLD" on
 * tronscan and Circle has ended TRON issuance, so there is no issuer-backed address to list.
 */

export type TronToken = {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
};

export type TronTokenTable = Readonly<Record<string, Readonly<Record<string, TronToken>>>>;

// Tether USD (6 decimals), https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t —
// tronscan verified; issuer page https://tether.to/en/supported-protocols/ lists the address.
const USDT: TronToken = Object.freeze({ symbol: "USDT", decimals: 6, name: "Tether USD" });

// Decentralized USD (18 decimals), https://tronscan.org/#/token20/TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz —
// tronscan verified, issuer usdd.io. The old TPYmHEhy…PDn contract is flagged USDDOLD and absent.
const USDD: TronToken = Object.freeze({ symbol: "USDD", decimals: 18, name: "Decentralized USD" });

// TrueUSD (18 decimals), https://tronscan.org/#/token20/TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4 —
// tronscan verified; issuer page https://tusd.io/ lists the address.
const TUSD: TronToken = Object.freeze({ symbol: "TUSD", decimals: 18, name: "TrueUSD" });

// Wrapped TRX (6 decimals), https://tronscan.org/#/token20/TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR —
// tronscan verified, issuer just.network.
const WTRX: TronToken = Object.freeze({ symbol: "WTRX", decimals: 6, name: "Wrapped TRX" });

// JUST (18 decimals), https://tronscan.org/#/token20/TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9 —
// tronscan verified, issuer just.network.
const JST: TronToken = Object.freeze({ symbol: "JST", decimals: 18, name: "JUST" });

// SUN (18 decimals), https://tronscan.org/#/token20/TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S —
// tronscan verified, issuer sun.io.
const SUN: TronToken = Object.freeze({ symbol: "SUN", decimals: 18, name: "SUN" });

// BitTorrent (18 decimals), https://tronscan.org/#/token20/TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4 —
// tronscan verified, issuer bittorrent.com.
const BTT: TronToken = Object.freeze({ symbol: "BTT", decimals: 18, name: "BitTorrent" });

// WINkLink (6 decimals), https://tronscan.org/#/token20/TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7 —
// tronscan verified, issuer winklink.org.
const WIN: TronToken = Object.freeze({ symbol: "WIN", decimals: 6, name: "WINkLink" });

// AINFT (6 decimals, symbol still NFT), https://tronscan.org/#/token20/TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq —
// tronscan verified, issuer ainft.com.
const NFT: TronToken = Object.freeze({ symbol: "NFT", decimals: 6, name: "AINFT" });

// Nile faucet USDT (6 decimals) — TRON's official Nile faucet page
// https://nileex.io/join/getJoinPage lists the token address; on-chain decimals() = 6.
const NILE_USDT: TronToken = Object.freeze({ symbol: "USDT", decimals: 6, name: "Tether USD" });

/** The built-in table. */
export const tronTokenTable: TronTokenTable = Object.freeze({
  "tron:728126428": Object.freeze({
    TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: USDT,
    TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz: USDD,
    TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4: TUSD,
    TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: WTRX,
    TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: JST,
    TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: SUN,
    TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4: BTT,
    TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7: WIN,
    TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq: NFT,
  }),
  "tron:3448148188": Object.freeze({
    TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: NILE_USDT,
  }),
});

export const lookupTronToken = (
  table: TronTokenTable,
  network: string,
  address: string,
): TronToken | undefined => table[network]?.[address];
