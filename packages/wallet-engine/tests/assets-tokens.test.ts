/**
 * Built-in token merge: refresh lists a network's table tokens without an addToken call — balances
 * batched in the same aggregate3 as customs, symbol/decimals from the table — and `verified` is
 * decided at read time: a hand-added table token still lists once, verified. Custom tokens persist
 * as `{ address }` records; the old `{ address, verified }` rows are read by address alone.
 *
 * MULTICALL3_ABI is copied here instead of imported from src/assets/evm.ts so the pre-fix run fails
 * on assertions rather than on a missing module. Likewise the Solana fake still answers the pre-fix
 * `{ mint }` filter so old code reaches its token list before failing on values.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { decodeFunctionData, encodeFunctionData, encodeFunctionResult } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import { AssetsController } from "../src/assets/controller.ts";
import { ERC20_ABI } from "../src/chains/evm.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
    stateMutability: "payable",
  },
] as const;

const logger = { warn: () => {} };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
const chains = {
  account: async () => Promise.reject(new Error("unmocked chains.account")),
};

const MAINNET = "eip155:1";
const OWNER = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const CUSTOM = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as `0x${string}`;
const OP_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as `0x${string}`;

const enc = (v: bigint): `0x${string}` => `0x${v.toString(16).padStart(64, "0")}`;

const BALANCE_OF = encodeFunctionData({
  abi: ERC20_ABI,
  functionName: "balanceOf",
  args: [OWNER],
});
const SYMBOL = encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" });
const DECIMALS = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" });
const AGG_SELECTOR = encodeFunctionData({
  abi: MULTICALL3_ABI,
  functionName: "aggregate3",
  args: [[]],
}).slice(0, 10);

type Call = { readonly to: string; readonly data: `0x${string}` };

/** One token's scripted chain answers; `rawDecimals` wins over `decimals` for broken answers. */
type TokenStub = {
  readonly balance?: bigint;
  readonly symbol?: string;
  readonly decimals?: number;
  readonly rawDecimals?: `0x${string}`;
};

/** The node's answer to one balanceOf/symbol/decimals call against `target`. */
const answerOf = (tokens: ReadonlyMap<string, TokenStub>, target: string, data: `0x${string}`) => {
  const stub = tokens.get(target.toLowerCase());
  if (data === BALANCE_OF) {
    return { success: true, returnData: enc(stub?.balance ?? 0n) };
  }
  if (data === SYMBOL) {
    return stub?.symbol === undefined
      ? { success: false, returnData: "0x" as `0x${string}` }
      : {
          success: true,
          returnData: encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "symbol",
            result: stub.symbol,
          }),
        };
  }
  if (data === DECIMALS) {
    if (stub?.rawDecimals !== undefined) {
      return { success: true, returnData: stub.rawDecimals };
    }
    return stub?.decimals === undefined
      ? { success: false, returnData: "0x" as `0x${string}` }
      : { success: true, returnData: enc(BigInt(stub.decimals)) };
  }
  return { success: false, returnData: "0x" as `0x${string}` };
};

/** A fake EVM node: decodes aggregate3 batches and answers per subcall like a real Multicall3. */
const evmClient = (tokens: ReadonlyMap<string, TokenStub>, calls: Call[]): PublicClient =>
  ({
    transport: {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_getBalance") {
          return Promise.resolve("0x0");
        }
        if (method !== "eth_call") {
          return Promise.reject(new Error(`unmocked ${method}`));
        }
        const [{ to, data }] = (params ?? [{}]) as [{ to?: string; data?: `0x${string}` }];
        const txData = data ?? "0x";
        calls.push({ to: String(to), data: txData });
        if (txData.startsWith(AGG_SELECTOR)) {
          const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: txData });
          const result = args[0].map((call) => answerOf(tokens, call.target, call.callData));
          return Promise.resolve(
            encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result }),
          );
        }
        return Promise.resolve(answerOf(tokens, String(to), txData).returnData);
      },
    },
  }) as unknown as PublicClient;

const make = (
  c: PublicClient,
  net: { readonly chainId: number; readonly multicall3?: string },
  store: EngineStore = createMemoryEngineStore(),
) =>
  new AssetsController({
    networks: {
      client: () => c,
      info: () => ({ family: "evm", chainId: net.chainId, multicall3: net.multicall3 }),
    } as never,
    chains,
    openStore: async () => Promise.resolve(store),
    setTimer: () => () => {},
    logger,
    gateway: undefined,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  });

const solanaFixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/solana-token-accounts.json"), "utf8"),
) as {
  readonly owner: string;
  readonly tokenProgram: { readonly context: unknown; readonly value: unknown[] };
  readonly token2022Program: { readonly context: unknown; readonly value: unknown[] };
};

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const solRpc = (
  calls: Array<{ readonly method: string; readonly params: unknown[] }>,
): SolanaRpc => ({
  call: async (method, params) => {
    calls.push({ method, params });
    if (method === "getBalance") {
      return Promise.resolve({ value: 0 });
    }
    if (method === "getMultipleAccounts") {
      const [keys] = params;
      // Held unknown mints cannot be inspected — they come back missing and stay hidden.
      return Promise.resolve({ value: (keys as string[]).map(() => null) });
    }
    if (method === "getAccountInfo") {
      return Promise.resolve({
        value: { data: { parsed: { info: { decimals: 6 } }, program: "spl-token" } },
      });
    }
    if (method === "getTokenAccountsByOwner") {
      const filter = obj(params[1]) ?? {};
      if (filter["programId"] === PROGRAM_IDS.token) {
        return Promise.resolve(solanaFixture.tokenProgram);
      }
      if (filter["programId"] === PROGRAM_IDS.token2022) {
        return Promise.resolve(solanaFixture.token2022Program);
      }
      // The pre-fix `{ mint }` filter: answer it so old code reaches the token list.
      return Promise.resolve({ context: { slot: 0 }, value: [] });
    }
    return Promise.reject(new Error(`unmocked ${method}`));
  },
});

/** Decoded aggregate3 calls of eth_call `index` — callers assert `calls` length first. */
const decodedAggregate = (calls: Call[], index = 0) =>
  decodeFunctionData({ abi: MULTICALL3_ABI, data: calls[index]?.data ?? "0x" });

const makeSolana = (calls: Array<{ readonly method: string; readonly params: unknown[] }>) =>
  new AssetsController({
    networks: {
      info: (n: string) => (n === SOL_NET ? { family: "solana" } : { family: "evm", chainId: 1 }),
      solanaRpc: () => solRpc(calls),
    } as never,
    chains,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger,
    gateway: undefined,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  });

describe("AssetsController built-in tokens", () => {
  it("lists the chain's built-ins without an add — one aggregate3, no metadata calls", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map([
        [USDC.toLowerCase(), { balance: 1_000_001n }],
        [USDT.toLowerCase(), { balance: 2_000_002n }],
      ]),
      calls,
    );
    const assets = make(c, { chainId: 1, multicall3: MULTICALL3 });
    await assets.init();
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT]);
    expect(balances.tokens[0]).toStrictEqual({
      address: USDC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      balance: "1000001",
      verified: true,
      spam: [],
      hidden: false,
    });
    expect(balances.tokens[1]).toStrictEqual({
      address: USDT,
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
      balance: "2000002",
      verified: true,
      spam: [],
      hidden: false,
    });
    // one eth_call total — the aggregate3 to Multicall3, targeting table keys in table order.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe(MULTICALL3);
    const agg = decodedAggregate(calls);
    expect(agg.args[0].map((call) => call.target)).toStrictEqual([USDC, USDT]);
    expect(agg.args[0].map((call) => call.callData)).toStrictEqual([BALANCE_OF, BALANCE_OF]);
  });

  it("shows only chainId 10's USDC there", async () => {
    const calls: Call[] = [];
    const c = evmClient(new Map([[OP_USDC.toLowerCase(), { balance: 42n }]]), calls);
    const assets = make(c, { chainId: 10, multicall3: MULTICALL3 });
    await assets.init();
    const balances = await assets.refresh(OWNER, "eip155:10");
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([OP_USDC]);
    expect(balances.tokens[0]?.verified).toBe(true);
    expect(balances.tokens[0]?.balance).toBe("42");
  });

  it("a network with no table entries shows only customs", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map([[CUSTOM.toLowerCase(), { balance: 9n, symbol: "TST", decimals: 6 }]]),
      calls,
    );
    const assets = make(c, { chainId: 56 });
    await assets.init();
    await assets.addToken("eip155:56", CUSTOM);
    const balances = await assets.refresh(OWNER, "eip155:56");
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([CUSTOM]);
    expect(balances.tokens[0]?.verified).toBe(false);
  });

  it("without multicall3, one balanceOf eth_call per tracked token", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map([
        [USDC.toLowerCase(), { balance: 5n }],
        [CUSTOM.toLowerCase(), { symbol: "TST", decimals: 6 }],
      ]),
      calls,
    );
    const assets = make(c, { chainId: 1 });
    await assets.init();
    await assets.addToken(MAINNET, CUSTOM);
    calls.length = 0;
    const balances = await assets.refresh(OWNER, MAINNET);
    const reads = calls.filter((call) => call.data === BALANCE_OF);
    expect(reads.map((call) => call.to)).toStrictEqual([USDC, USDT, CUSTOM]);
    expect(calls.every((call) => !call.data.startsWith(AGG_SELECTOR))).toBe(true);
    expect(balances.tokens[0]?.balance).toBe("5");
  });

  it("a custom token is verified: false beside verified built-ins", async () => {
    const calls: Call[] = [];
    const c = evmClient(new Map([[CUSTOM.toLowerCase(), { symbol: "TST", decimals: 6 }]]), calls);
    const assets = make(c, { chainId: 1, multicall3: MULTICALL3 });
    await assets.init();
    await assets.addToken(MAINNET, CUSTOM);
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(balances.tokens.map((t) => t.verified)).toStrictEqual([true, true, false]);
  });

  it("a hand-added built-in lists once, verified — added checksummed or lower-case", async () => {
    const calls: Call[] = [];
    const c = evmClient(new Map(), calls);
    const assets = make(c, { chainId: 1, multicall3: MULTICALL3 });
    await assets.init();
    await assets.addToken(MAINNET, USDC.toLowerCase());
    await assets.addToken(MAINNET, USDC);
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT]);
    expect(balances.tokens[0]?.verified).toBe(true);
  });

  it("persists customs as { address } records and reads them back on init", async () => {
    const store = createMemoryEngineStore();
    const c = evmClient(new Map([[CUSTOM.toLowerCase(), { symbol: "TST", decimals: 6 }]]), []);
    const assets = make(c, { chainId: 1, multicall3: MULTICALL3 }, store);
    await assets.init();
    await assets.addToken(MAINNET, CUSTOM);
    const raw = await store.collection("assets-custom-tokens").get("customTokens");
    expect(JSON.parse(new TextDecoder().decode(raw))).toStrictEqual({
      [MAINNET]: [{ address: CUSTOM }],
    });
    const fresh = make(c, { chainId: 1, multicall3: MULTICALL3 }, store);
    await fresh.init();
    const balances = await fresh.refresh(OWNER, MAINNET);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT, CUSTOM]);
  });

  it("solana mainnet lists the table mints, verified, from the holdings read alone", async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const assets = makeSolana(calls);
    await assets.init();
    const balances = await assets.refresh(solanaFixture.owner, SOL_NET);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([SOL_USDC, SOL_USDT]);
    expect(balances.tokens[0]).toStrictEqual({
      address: SOL_USDC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      balance: "1110038251",
      verified: true,
      spam: [],
      hidden: false,
    });
    expect(balances.tokens[1]?.balance).toBe("0");
    // Table rows need no mint read; the held unknown mints in the fixture are inspected once
    // in a single getMultipleAccounts and stay hidden while they come back missing.
    expect(calls.filter((c) => c.method === "getAccountInfo")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
  });

  it("reads a custom token's metadata at addToken; refreshes batch balances only", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map([[CUSTOM.toLowerCase(), { balance: 7n, symbol: "TST", decimals: 6 }]]),
      calls,
    );
    const assets = make(c, { chainId: 1, multicall3: MULTICALL3 });
    await assets.init();
    await assets.addToken(MAINNET, CUSTOM);
    // addToken validated the token: one symbol and one decimals call against it.
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.to)).toStrictEqual([CUSTOM, CUSTOM]);
    expect(calls.map((call) => call.data).toSorted()).toStrictEqual([SYMBOL, DECIMALS].toSorted());
    calls.length = 0;
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT, CUSTOM]);
    // Balances only — the addToken read seeded the per-unlock metadata cache.
    expect(calls).toHaveLength(1);
    expect(decodedAggregate(calls).args[0].map((call) => call.callData)).toStrictEqual([
      BALANCE_OF,
      BALANCE_OF,
      BALANCE_OF,
    ]);
    calls.length = 0;
    await assets.refresh(OWNER, MAINNET);
    expect(calls).toHaveLength(1);
    expect(decodedAggregate(calls).args[0].map((call) => call.callData)).toStrictEqual([
      BALANCE_OF,
      BALANCE_OF,
      BALANCE_OF,
    ]);
  });

  it.each([{ multicall3: MULTICALL3 }, {}])(
    "a custom token whose decimals cannot be read is rejected, never persisted (%j)",
    async (net) => {
      const calls: Call[] = [];
      const store = createMemoryEngineStore();
      const c = evmClient(
        new Map([
          [CUSTOM.toLowerCase(), { balance: 1_000_000n, symbol: "TKN", rawDecimals: "0x" }],
        ]),
        calls,
      );
      const assets = make(c, { chainId: 1, ...net }, store);
      await assets.init();
      await expect(assets.addToken(MAINNET, CUSTOM)).rejects.toThrow("not a readable ERC-20");
      expect(assets.isTracked(MAINNET, CUSTOM)).toBe(false);
      const raw = await store.collection("assets-custom-tokens").get("customTokens");
      expect(raw).toBeUndefined();
      const balances = await assets.refresh(OWNER, MAINNET);
      expect(balances.tokens.find((t) => t.address === CUSTOM)).toBeUndefined();
      expect(balances.tokens.every((t) => t.decimals !== 18)).toBe(true);
    },
  );

  it("an undecodable decimals answer is not cached — the next poll asks again", async () => {
    const calls: Call[] = [];
    const store = createMemoryEngineStore();
    // Persisted by an earlier session: the add-time read is long gone, so the refresh must ask.
    await store
      .collection("assets-custom-tokens")
      .put(
        "customTokens",
        new TextEncoder().encode(JSON.stringify({ [MAINNET]: [{ address: CUSTOM }] })),
      );
    const token = new Map<string, TokenStub>([
      [CUSTOM.toLowerCase(), { balance: 5n, symbol: "TKN", rawDecimals: "0x" }],
    ]);
    const c = evmClient(token, calls);
    const assets = make(c, { chainId: 1 }, store);
    await assets.init();
    const first = await assets.refresh(OWNER, MAINNET);
    expect(first.tokens.find((t) => t.address === CUSTOM)).toBeUndefined();
    token.set(CUSTOM.toLowerCase(), { balance: 5n, symbol: "TKN", decimals: 7 });
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(balances.tokens.find((t) => t.address === CUSTOM)?.decimals).toBe(7);
  });
});
