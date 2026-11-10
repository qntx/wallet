/**
 * Gateway quotes are bound to the request: tokens, amounts, destination and the slippage /
 * relay-fee floor are checked before a quote is trusted.
 */
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "@qntx/wallet-chains";
import { EVM_NATIVE_ASSET } from "@qntx/wallet-chains/evm";
import { SOLANA_NATIVE_ASSET, WSOL_MINT } from "@qntx/wallet-chains/solana";

import { ZEROX_NATIVE_TOKEN } from "../src/gateway/contract/quotes.ts";
import { fetchBridgeQuote, fetchJupiterQuote, fetchSwapQuote } from "../src/swaps/quote.ts";
import type { AccountRef } from "../src/transactions/route.ts";

const TAKER = "0x4444444444444444444444444444444444444444";
const SELL = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BUY = "0x19993B3Cf15c1055063468EB932F5e335A7526ea";
const WRONG = "0x1111111111111111111111111111111111111111";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_OTHER = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44",
};

const deps = (body: unknown, calls?: { n: number }) => ({
  fetch: (async () => {
    await Promise.resolve();
    if (calls !== undefined) {
      calls.n += 1;
    }
    return Response.json(body);
  }) as typeof globalThis.fetch,
  gateway: { url: "https://gw.test", installId: "i" },
  address: async () => {
    await Promise.resolve();
    return TAKER;
  },
  now: () => 0,
});

const zeroXBody = (over: Record<string, unknown> = {}) => ({
  liquidity: true,
  provider: "0x",
  sellToken: SELL,
  buyToken: BUY,
  sellAmount: "1000000",
  buyAmount: "2000000",
  minBuyAmount: "1990000",
  allowanceTarget: null,
  transaction: { to: BUY, data: "0x", value: "0", gas: null },
  fees: { integrator: null, zeroEx: null },
  blockNumber: "1",
  ...over,
});

const swapParams = {
  account: ACCOUNT,
  network: "eip155:1",
  sell: SELL,
  buy: BUY,
  amount: 1_000_000n,
  slippageBps: 50,
};

const jupiterBody = (over: Record<string, unknown> = {}) => ({
  liquidity: true,
  provider: "jupiter",
  inputMint: MINT,
  outputMint: MINT_OTHER,
  inAmount: "1000000",
  outAmount: "2000000",
  otherAmountThreshold: "1990000",
  slippageBps: 50,
  setup: [],
  swap: {
    programId: MINT,
    accounts: [{ address: MINT_OTHER, signer: false, writable: true }],
    data: "AA==",
  },
  cleanup: null,
  lookupTables: [],
  ...over,
});

const solParams = {
  account: ACCOUNT,
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  sell: MINT,
  buy: MINT_OTHER,
  amount: 1_000_000n,
  slippageBps: 50,
};

const bridgeBody = (over: Record<string, unknown> = {}) => ({
  liquidity: true,
  provider: "across",
  inputToken: SELL,
  outputToken: BUY,
  inputAmount: "1000000",
  outputAmount: "990000",
  destinationNetwork: "eip155:8453",
  quoteTimestamp: 1,
  fillDeadline: 2,
  exclusiveRelayer: TAKER,
  exclusivityParameter: 0,
  spokePool: BUY,
  limits: { minDeposit: "1", maxDeposit: "999999999" },
  ...over,
});

const bridgeParams = {
  account: ACCOUNT,
  network: "eip155:1",
  destinationNetwork: "eip155:8453",
  inputToken: SELL,
  outputToken: BUY,
  amount: 1_000_000n,
  maxFeeBps: 100,
};

describe("0x quote binding", () => {
  it("accepts a quote matching the request", async () => {
    const q = await fetchSwapQuote(deps(zeroXBody()), swapParams);
    expect(q?.provider).toBe("0x");
    expect(q?.sellAmount).toBe(1_000_000n);
    expect(q?.minBuyAmount).toBe(1_990_000n);
  });

  it.each([
    ["sell token", { sellToken: WRONG }],
    ["buy token", { buyToken: WRONG }],
    ["sell amount", { sellAmount: "1000001" }],
    ["minimum", { minBuyAmount: "1989999" }],
  ])("rejects a quote whose %s differs", async (_what, over) => {
    await expect(fetchSwapQuote(deps(zeroXBody(over)), swapParams)).rejects.toThrow(ChainError);
  });

  it("accepts a minimum exactly at the slippage floor", async () => {
    const q = await fetchSwapQuote(deps(zeroXBody({ minBuyAmount: "1990000" })), swapParams);
    expect(q).toBeDefined();
  });

  it("maps the native sentinel back to the native asset id", async () => {
    const q = await fetchSwapQuote(deps(zeroXBody({ sellToken: ZEROX_NATIVE_TOKEN })), {
      ...swapParams,
      sell: EVM_NATIVE_ASSET,
    });
    expect(q?.sell).toBe(EVM_NATIVE_ASSET);
  });

  it("returns undefined when the route has no liquidity", async () => {
    await expect(fetchSwapQuote(deps({ liquidity: false }), swapParams)).resolves.toBeUndefined();
  });
});

describe("jupiter quote binding", () => {
  it("accepts a quote matching the request", async () => {
    const q = await fetchJupiterQuote(deps(jupiterBody()), solParams);
    expect(q?.provider).toBe("jupiter");
    expect(q?.minBuyAmount).toBe(1_990_000n);
  });

  it.each([
    ["sell token", { inputMint: MINT_OTHER }, { sell: SELL }],
    ["sell amount", { inAmount: "1000001" }, {}],
    ["minimum", { otherAmountThreshold: "1989999" }, {}],
  ])("rejects a quote whose %s differs", async (_what, over, params) => {
    await expect(
      fetchJupiterQuote(deps(jupiterBody(over)), { ...solParams, ...params }),
    ).rejects.toThrow(ChainError);
  });

  it("maps the wrapped-SOL mint to the native asset id", async () => {
    const q = await fetchJupiterQuote(deps(jupiterBody({ inputMint: WSOL_MINT })), {
      ...solParams,
      sell: SOLANA_NATIVE_ASSET,
    });
    expect(q?.sell).toBe(SOLANA_NATIVE_ASSET);
  });

  it("returns undefined when the route has no liquidity", async () => {
    await expect(fetchJupiterQuote(deps({ liquidity: false }), solParams)).resolves.toBeUndefined();
  });
});

describe("across bridge quote binding", () => {
  it("accepts a quote matching the request", async () => {
    const q = await fetchBridgeQuote(deps(bridgeBody()), bridgeParams);
    expect(q?.provider).toBe("across");
    expect(q?.outputAmount).toBe(990_000n);
  });

  it.each([
    ["output token", { outputToken: WRONG }],
    ["input amount", { inputAmount: "1000001" }],
    ["destination network", { destinationNetwork: "eip155:137" }],
    ["output amount", { outputAmount: "989999" }],
  ])("rejects a quote whose %s differs", async (_what, over) => {
    await expect(fetchBridgeQuote(deps(bridgeBody(over)), bridgeParams)).rejects.toThrow(
      ChainError,
    );
  });

  it("accepts an output exactly at the fee floor", async () => {
    const q = await fetchBridgeQuote(deps(bridgeBody({ outputAmount: "990000" })), bridgeParams);
    expect(q).toBeDefined();
  });

  it.each([[-1], [10_001], [1.5]])("rejects maxFeeBps %s before any fetch", async (bps) => {
    const calls = { n: 0 };
    await expect(
      fetchBridgeQuote(deps(bridgeBody(), calls), { ...bridgeParams, maxFeeBps: bps }),
    ).rejects.toThrow(ChainError);
    expect(calls.n).toBe(0);
  });

  it("returns undefined when the route has no liquidity", async () => {
    await expect(
      fetchBridgeQuote(deps({ liquidity: false }), bridgeParams),
    ).resolves.toBeUndefined();
  });
});
