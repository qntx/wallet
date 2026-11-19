/**
 * Exact fiat arithmetic (bigint fixed-point, no float), the holdings the engine already tracks
 * mapped to their CAIP-19 price ids, and the valuation that sums them at the current quotes.
 */
import { describe, expect, it } from "vite-plus/test";

import type { AccountBalances } from "../src/assets/controller.ts";
import { assetValue, formatDecimal, parseDecimal, sumDecimals } from "../src/prices/decimal.ts";
import {
  balanceHoldings,
  groupHoldings,
  heldAssets,
  sparkHolding,
} from "../src/prices/holdings.ts";
import { PRICE_STALE_MS, valueHoldings } from "../src/prices/valuation.ts";
import type { SparkAccountState } from "../src/spark/controller.ts";

const MAINNET = "eip155:1";
const ETH = `${MAINNET}/slip44:60`;
const SEPOLIA = "eip155:11155111";
const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
const BTC = `${BTC_MAINNET}/slip44:0`;
const SOL_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL = `${SOL_MAINNET}/slip44:501`;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_ASSET = `${MAINNET}/erc20:${USDC.toLowerCase()}`;
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDC_ASSET = `${SOL_MAINNET}/token:${SOL_USDC}`;
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

const balances = (over: Partial<AccountBalances> = {}): AccountBalances => ({
  native: "0",
  tokens: [],
  ...over,
});

describe("decimal", () => {
  it("values 10^18 wei at a 16-decimal price exactly", () => {
    const value = assetValue(10n ** 18n, 18, parseDecimal("1810.4413516935772"));
    expect(formatDecimal(value)).toBe("1810.4413516935772");
  });

  it("values one base unit of an 18-decimal asset at the smallest fiatPrice", () => {
    const value = assetValue(1n, 18, parseDecimal("0.000000000000000001"));
    expect(formatDecimal(value)).toBe(`0.${"0".repeat(35)}1`);
  });

  it("values the full uint256 range without losing a digit", () => {
    const value = assetValue(2n ** 256n - 1n, 18, parseDecimal("64683.08229625645"));
    // Independent oracle: a plain BigInt product with the point inserted by hand — no library
    // formatting, so a rounding bug in either direction shows.
    const product = (2n ** 256n - 1n) * 6468308229625645n; // price as 11-dp fixed point
    const digits = product.toString().padStart(30, "0"); // scale 18 + 11 = 29
    const point = digits.length - 29;
    const oracle = `${digits.slice(0, point)}.${digits.slice(point)}`.replace(/\.?0+$/, "");
    expect(formatDecimal(value)).toBe(oracle);
  });

  it("sums tenths exactly where a binary float cannot", () => {
    // 0.1 + 0.2 as IEEE-754 is 0.30000000000000004; the fixed-point sum is exactly 0.3.
    const total = sumDecimals([
      assetValue(100_000n, 6, parseDecimal("1")),
      assetValue(200_000n, 6, parseDecimal("1")),
    ]);
    expect(formatDecimal(total)).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("sums decimals of mixed scales at the largest scale", () => {
    const total = sumDecimals([
      { units: 15n, scale: 1 },
      { units: 25n, scale: 2 },
      { units: 7n, scale: 0 },
    ]);
    expect(total).toStrictEqual({ units: 875n, scale: 2 });
    expect(formatDecimal(total)).toBe("8.75");
  });

  it.each(["1e5", "", "1.2.3"])("parseDecimal rejects %j", (text) => {
    expect(() => parseDecimal(text)).toThrow(TypeError);
  });
});

describe("balanceHoldings", () => {
  it("maps a mainnet balance to slip44 and lowercase erc20 asset ids", () => {
    const holdings = balanceHoldings(
      `${MAINNET}:${ADDR}`,
      balances({
        native: "42",
        tokens: [
          {
            address: USDC,
            symbol: "USDC",
            decimals: 6,
            balance: "7",
            verified: true,
            spam: [],
            hidden: false,
          },
        ],
      }),
    );
    expect(holdings).toStrictEqual([
      {
        key: `${MAINNET}:${ADDR}`,
        network: MAINNET,
        asset: ETH,
        symbol: "ETH",
        decimals: 18,
        amount: 42n,
      },
      {
        key: `${MAINNET}:${ADDR}`,
        network: MAINNET,
        asset: USDC_ASSET,
        symbol: "USDC",
        decimals: 6,
        amount: 7n,
      },
    ]);
  });

  it("sums a bitcoin group's confirmed, unconfirmed and protected sats", () => {
    const [native] = balanceHoldings(
      `${BTC_MAINNET}:w:0`,
      balances({ native: "100", unconfirmed: "20", protected: "3" }),
    );
    expect(native).toMatchObject({ asset: BTC, symbol: "BTC", decimals: 8, amount: 123n });
  });

  it("counts a Solana token's frozen amount and prices it as an SPL mint", () => {
    const holdings = balanceHoldings(
      `${SOL_MAINNET}:owner`,
      balances({
        native: "5",
        tokens: [
          {
            address: SOL_USDC,
            symbol: "USDC",
            decimals: 6,
            balance: "10",
            frozen: "4",
            verified: true,
            spam: [],
            hidden: false,
          },
        ],
      }),
    );
    expect(holdings[0]).toMatchObject({ asset: SOL, symbol: "SOL", decimals: 9, amount: 5n });
    expect(holdings[1]).toMatchObject({ asset: SOL_USDC_ASSET, amount: 14n });
  });

  it("leaves the asset undefined on a testnet, whose coins have no price", () => {
    const holdings = balanceHoldings(
      `${SEPOLIA}:${ADDR}`,
      balances({
        native: "9",
        tokens: [
          {
            address: USDC,
            symbol: "USDC",
            decimals: 6,
            balance: "1",
            verified: true,
            spam: [],
            hidden: false,
          },
        ],
      }),
    );
    expect(holdings.map((h) => h.asset)).toStrictEqual([undefined, undefined]);
    expect(holdings[0]).toMatchObject({ symbol: "ETH", decimals: 18, amount: 9n });
  });

  it("reads nothing from a key on an unknown network", () => {
    expect(balanceHoldings("cosmos:cosmoshub-4:cosmos1", balances({ native: "1" }))).toStrictEqual(
      [],
    );
  });
});

describe("sparkHolding", () => {
  const account = (over: Partial<SparkAccountState> = {}): SparkAccountState => ({
    status: "ready",
    balanceSats: 500,
    ...over,
  });

  it("is mainnet BTC once the balance is known", () => {
    expect(sparkHolding("w:0:mainnet", account(), "mainnet")).toStrictEqual({
      key: "spark:w:0:mainnet",
      network: BTC_MAINNET,
      asset: BTC,
      symbol: "BTC",
      decimals: 8,
      amount: 500n,
    });
  });

  it("has no priceable asset on regtest and none before the balance arrives", () => {
    expect(sparkHolding("w:0:regtest", account(), "regtest")).toMatchObject({
      asset: undefined,
      amount: 500n,
    });
    const connecting: SparkAccountState = { status: "connecting" };
    expect(sparkHolding("w:0:mainnet", connecting, "mainnet")).toBeUndefined();
  });
});

describe("heldAssets", () => {
  it("dedupes, sorts, drops testnets and includes the spark BTC balance", () => {
    const assets = heldAssets(
      {
        [`${MAINNET}:${ADDR}`]: balances({ native: "1" }),
        [`${MAINNET}:0x00000000000000000000000000000000deadbeef`]: balances({ native: "2" }),
        [`${SEPOLIA}:${ADDR}`]: balances({ native: "3" }),
      },
      { "w:0:mainnet": { status: "ready", balanceSats: 10 } },
      "mainnet",
    );
    expect(assets).toStrictEqual([BTC, ETH]);
  });
});

describe("groupHoldings", () => {
  it("returns only the group's own keys, never another address or group", () => {
    const holdings = groupHoldings({
      balances: {
        [`${MAINNET}:${ADDR}`]: balances({ native: "1" }),
        [`${MAINNET}:0x00000000000000000000000000000000deadbeef`]: balances({ native: "2" }),
        [`${BTC_MAINNET}:w:0`]: balances({ native: "3" }),
        [`${BTC_MAINNET}:w:1`]: balances({ native: "4" }),
      },
      spark: {
        "w:0:mainnet": { status: "ready", balanceSats: 5 },
        "w:1:mainnet": { status: "ready", balanceSats: 6 },
      },
      sparkNetwork: "mainnet",
      group: { walletId: "w", groupIndex: 0 },
      addresses: [{ network: MAINNET, address: ADDR }],
      bitcoin: [BTC_MAINNET],
    });
    expect(holdings.map((h) => h.key)).toStrictEqual([
      `${MAINNET}:${ADDR}`,
      `${BTC_MAINNET}:w:0`,
      "spark:w:0:mainnet",
    ]);
    expect(holdings.map((h) => h.amount)).toStrictEqual([1n, 3n, 5n]);
  });

  it("skips keys and a spark account with nothing in state", () => {
    expect(
      groupHoldings({
        balances: {},
        spark: {},
        sparkNetwork: "mainnet",
        group: { walletId: "w", groupIndex: 0 },
        addresses: [{ network: MAINNET, address: ADDR }],
        bitcoin: [BTC_MAINNET],
      }),
    ).toStrictEqual([]);
  });
});

describe("valueHoldings", () => {
  const quote = (price: string, updatedAt: number) => ({
    price,
    change24h: null,
    updatedAt,
  });

  const holding = (over: Partial<Parameters<typeof valueHoldings>[0][number]> = {}) => ({
    key: `${MAINNET}:${ADDR}`,
    network: MAINNET,
    asset: ETH,
    symbol: "ETH",
    decimals: 18,
    amount: 0n,
    ...over,
  });

  it("sums every priced holding into an exact total", () => {
    const now = 1_700_000_000_000;
    const valuation = valueHoldings(
      [
        holding({ amount: 2n * 10n ** 18n }),
        holding({ asset: USDC_ASSET, symbol: "USDC", decimals: 6, amount: 1_000_000n }),
        holding({ asset: BTC, symbol: "BTC", decimals: 8, amount: 100_000_000n }),
      ],
      {
        currency: "usd",
        quotes: {
          [ETH]: quote("1000", now),
          [USDC_ASSET]: quote("0.9998", now),
          [BTC]: quote("50000", now),
        },
      },
      now,
    );
    expect(valuation.total).toBe("52000.9998");
    expect(valuation.unpriced).toBe(0);
    expect(valuation.stale).toBe(false);
    expect(valuation.holdings.map((h) => h.value)).toStrictEqual(["2000", "0.9998", "50000"]);
  });

  it("leaves testnet and quote-less holdings unpriced, with no price or value", () => {
    const now = 1_700_000_000_000;
    const valuation = valueHoldings(
      [
        holding({ asset: undefined, network: SEPOLIA, amount: 9n }),
        holding({ asset: USDC_ASSET, symbol: "USDC", decimals: 6, amount: 1_000_000n }),
      ],
      { currency: "usd", quotes: {} },
      now,
    );
    expect(valuation.total).toBe("0");
    expect(valuation.unpriced).toBe(2);
    expect(valuation.holdings.map((h) => h.price)).toStrictEqual([undefined, undefined]);
    expect(valuation.holdings.map((h) => h.value)).toStrictEqual([undefined, undefined]);
  });

  it("marks a quote stale only past PRICE_STALE_MS, and the valuation iff one contributed", () => {
    const now = 1_700_000_000_000;
    const at = (age: number) =>
      valueHoldings(
        [holding({ amount: 10n ** 18n })],
        { currency: "usd", quotes: { [ETH]: quote("1", now - age) } },
        now,
      );
    expect(at(PRICE_STALE_MS).holdings[0]?.price?.stale).toBe(false);
    expect(at(PRICE_STALE_MS).stale).toBe(false);
    expect(at(PRICE_STALE_MS + 1).holdings[0]?.price?.stale).toBe(true);
    expect(at(PRICE_STALE_MS + 1).stale).toBe(true);

    // A stale quote that prices no holding does not mark the valuation stale.
    const unpriced = valueHoldings(
      [holding({ asset: USDC_ASSET })],
      { currency: "usd", quotes: { [ETH]: quote("1", now - PRICE_STALE_MS - 1) } },
      now,
    );
    expect(unpriced.stale).toBe(false);
  });

  it("passes the state's currency through", () => {
    const valuation = valueHoldings(
      [holding({ amount: 10n ** 18n })],
      { currency: "eur", quotes: { [ETH]: quote("900", 1_700_000_000_000) } },
      1_700_000_000_000,
    );
    expect(valuation.currency).toBe("eur");
    expect(valuation.total).toBe("900");
  });
});
