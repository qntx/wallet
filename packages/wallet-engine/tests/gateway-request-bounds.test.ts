import { describe, expect, it } from "vite-plus/test";

import {
  HISTORY_CURSOR_MAX,
  accepts,
  bridgeQuoteRequest,
  historyRequest,
  swapQuoteRequest,
  swapQuoteSolanaRequest,
} from "../src/gateway/contract/index.ts";

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const PUBKEY = "11111111111111111111111111111111";

describe("request schemas refuse what the upstream would reject", () => {
  it.each([
    ["zero", "0", true],
    ["int64 max", HISTORY_CURSOR_MAX.toString(), true],
    ["int64 max + 1", (HISTORY_CURSOR_MAX + 1n).toString(), false],
    ["2^64", (2n ** 64n).toString(), false],
    ["4000 digits", "9".repeat(4000), false],
    ["hex", "0x10", false],
    ["a fraction", "1.5", false],
  ])("history cursor %s accepted: %s", (_label, cursor, ok) => {
    expect(accepts(historyRequest, { address: ADDRESS, cursor })).toBe(ok);
  });

  const UINT256_MAX = 2n ** 256n - 1n;
  const swap = (sellAmount: string) => ({
    network: "eip155:1",
    sellToken: ADDRESS,
    buyToken: ADDRESS,
    sellAmount,
    taker: ADDRESS,
    slippageBps: "100",
  });
  const bridge = (amount: string) => ({
    network: "eip155:1",
    destinationNetwork: "eip155:10",
    inputToken: ADDRESS,
    outputToken: ADDRESS,
    amount,
    taker: ADDRESS,
  });
  const solana = (amount: string) => ({
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    inputMint: PUBKEY,
    outputMint: PUBKEY,
    amount,
    taker: PUBKEY,
    slippageBps: "50",
  });

  it.each([
    ["one", "1", true],
    ["uint256 max", UINT256_MAX.toString(), true],
    ["uint256 max + 1", (UINT256_MAX + 1n).toString(), false],
    ["zero", "0", false],
    ["a leading zero", "01", false],
  ])("EVM quote amount %s accepted: %s", (_label, amount, ok) => {
    expect(accepts(swapQuoteRequest, swap(amount))).toBe(ok);
    expect(accepts(bridgeQuoteRequest, bridge(amount))).toBe(ok);
  });

  it.each([
    ["one", "1", true],
    ["u64 max", (2n ** 64n - 1n).toString(), true],
    ["2^64", (2n ** 64n).toString(), false],
    ["an exponent", "1e3", false],
  ])("Solana quote amount %s accepted: %s", (_label, amount, ok) => {
    expect(accepts(swapQuoteSolanaRequest, solana(amount))).toBe(ok);
  });
});
