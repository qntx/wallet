/**
 * The spam heuristics unit-tested alone: each reason, their fixed order, and the verified-owner
 * rule that a token never impersonates itself — only another address holding its symbol flags
 * `impersonation`.
 */
import { describe, expect, it } from "vite-plus/test";

import { spamReasons, symbolOwners, suspiciousTokenSymbol } from "../src/assets/spam.ts";

const REAL = "0x1111111111111111111111111111111111111111";
const FAKE = "0x2222222222222222222222222222222222222222";
const OWNERS = symbolOwners([
  [REAL, { symbol: "USDC" }],
  ["mint9opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh", { symbol: "BONK" }],
]);

describe("spamReasons", () => {
  it("flags nothing for a clean unverified token", () => {
    expect(
      spamReasons({ address: FAKE, symbol: "TST", name: "Test Token", owners: OWNERS }),
    ).toStrictEqual([]);
  });

  it("impersonation fires on another address's verified symbol, never on the owner itself", () => {
    expect(
      spamReasons({ address: FAKE, symbol: "USDC", name: "Fake USD", owners: OWNERS }),
    ).toStrictEqual(["impersonation"]);
    expect(
      spamReasons({ address: REAL, symbol: "USDC", name: "USD Coin", owners: OWNERS }),
    ).toStrictEqual([]);
    // Case-insensitive on the symbol, exact on the canonical address.
    expect(spamReasons({ address: FAKE, symbol: "usdc", owners: OWNERS })).toStrictEqual([
      "impersonation",
    ]);
  });

  it.each([
    ["SCAM~", "suspicious-symbol"],
    ["FREE~MONEY", "suspicious-symbol"],
  ])("flags a symbol that cannot be a ticker (%s)", (symbol, reason) => {
    expect(spamReasons({ address: FAKE, symbol, owners: OWNERS })).toStrictEqual([reason]);
  });

  it("flags a link smuggled into symbol or name", () => {
    expect(
      spamReasons({
        address: FAKE,
        symbol: "OK",
        name: "Claim at free-coins.xyz now",
        owners: OWNERS,
      }),
    ).toStrictEqual(["link-in-name"]);
    expect(spamReasons({ address: FAKE, symbol: "https://scam.io", owners: OWNERS })).toStrictEqual(
      ["suspicious-symbol", "link-in-name"],
    );
  });

  it("flags Token-2022 mint extensions", () => {
    expect(
      spamReasons({ address: FAKE, symbol: "TKN", owners: OWNERS, permanentDelegate: true }),
    ).toStrictEqual(["permanent-delegate"]);
    expect(
      spamReasons({ address: FAKE, symbol: "TKN", owners: OWNERS, nonTransferable: true }),
    ).toStrictEqual(["non-transferable"]);
    expect(
      spamReasons({
        address: FAKE,
        symbol: "TKN",
        owners: OWNERS,
        permanentDelegate: false,
        nonTransferable: false,
      }),
    ).toStrictEqual([]);
  });

  it("reports several reasons in the type's fixed order", () => {
    expect(
      spamReasons({
        address: FAKE,
        symbol: "USDC",
        name: "claim at usdc-airdrop.com",
        owners: OWNERS,
        permanentDelegate: true,
        nonTransferable: true,
      }),
    ).toStrictEqual(["impersonation", "link-in-name", "permanent-delegate", "non-transferable"]);
  });
});

describe("suspiciousTokenSymbol", () => {
  it("accepts ordinary tickers and rejects domains and odd characters", () => {
    expect(suspiciousTokenSymbol("USDC")).toBe(false);
    expect(suspiciousTokenSymbol("cbBTC")).toBe(false);
    expect(suspiciousTokenSymbol("SCAM.COM")).toBe(true);
    expect(suspiciousTokenSymbol("t.co/x")).toBe(true);
    expect(suspiciousTokenSymbol("WAY_TOO_LONG_SYMBOL_XYZ")).toBe(true);
  });
});
