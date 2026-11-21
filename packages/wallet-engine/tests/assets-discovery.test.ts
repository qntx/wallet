/**
 * Token discovery and mint inspection (R3):
 *
 * - EVM: the first poll of an unlock scans the gateway token list alongside table+custom balances in
 *   the same aggregate3 batches; a listed token with a balance is shown verified only when its
 *   on-chain decimals equal the list's. List tokens impersonating a table symbol are never
 *   eligible. Chain metadata (decimals) is read once per unlock in one aggregate3.
 * - Solana: held mints that are neither table nor custom are inspected in one getMultipleAccounts per
 *   50 mints — the mint account plus its Metaplex metadata PDA, the PDA asserted against real
 *   recorded mainnet addresses. Token-2022 `tokenMetadata` beats Metaplex; an NFT mint (decimals 0,
 *   supply 1) is omitted; a mint without a valid symbol shows "?".
 * - Spam reasons flag unverified tokens; a flagged token is hidden until `setTokenHidden` explicitly
 *   shows it, and the verdict persists across unlocks.
 *
 * The mint fixture is a recorded mainnet getMultipleAccounts answer (see its `source`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getAddressDecoder } from "@solana/kit";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import type { AccountBalances } from "../src/assets/controller.ts";
import { AssetsController } from "../src/assets/controller.ts";
import { TokenLists } from "../src/assets/token-lists.ts";
import { ERC20_ABI } from "../src/chains/evm.ts";
import { gatewaySession } from "../src/gateway/client.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

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
const chains = { account: async () => Promise.reject(new Error("unmocked chains.account")) };

const MAINNET = "eip155:1";
const OWNER = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as `0x${string}`;
const CUSTOM = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const LISTED = "0x1abc00000000000000000000000000000000beef" as `0x${string}`;
const UNHELD = "0x2abc00000000000000000000000000000000beef" as `0x${string}`;
const FAKER = "0x3abc00000000000000000000000000000000beef" as `0x${string}`;

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

/** Decoded aggregate3 calls of eth_call `index` — callers assert `calls` length first. */
const decodedAggregate = (calls: Call[], index = 0) =>
  decodeFunctionData({ abi: MULTICALL3_ABI, data: calls[index]?.data ?? "0x" });

type TokenStub = {
  readonly balance?: bigint;
  readonly symbol?: string;
  readonly decimals?: number;
};

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
    return stub?.decimals === undefined
      ? { success: false, returnData: "0x" as `0x${string}` }
      : { success: true, returnData: enc(BigInt(stub.decimals)) };
  }
  return { success: false, returnData: "0x" as `0x${string}` };
};

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

/** Parses a stored engine-store value; missing rows decode as undefined. */
const decodeStore = (raw: Uint8Array | undefined): unknown =>
  raw === undefined ? undefined : JSON.parse(new TextDecoder().decode(raw));

const GATEWAY = {
  url: "https://gateway.example",
  clientIds: { evm: "e", solana: "s", bitcoin: "b", tron: "t", service: "v" },
};

type FetchCall = { readonly url: string; readonly headers?: Headers };

/** A fetch that serves one scripted token-list document per request and records headers. */
const listFetch = (
  documents: ReadonlyArray<{ readonly status: number; readonly body?: unknown; etag?: string }>,
  calls: FetchCall[],
): typeof globalThis.fetch =>
  (async (input: unknown, init?: { readonly headers?: Record<string, string> }) => {
    await Promise.resolve();
    calls.push({
      url: String(input),
      ...(init?.headers === undefined ? {} : { headers: new Headers(init.headers) }),
    });
    const doc = documents[Math.min(calls.length - 1, documents.length - 1)];
    if (doc === undefined || doc.status === 404) {
      return new Response(null, { status: 404 });
    }
    if (doc.status !== 200) {
      return new Response(null, { status: doc.status });
    }
    const headers = new Headers();
    if (doc.etag !== undefined) {
      headers.set("etag", doc.etag);
    }
    return Response.json(doc.body, { status: 200, headers });
  }) as typeof globalThis.fetch;

const listDoc = (network: string, version: number, tokens: ReadonlyArray<unknown>) => ({
  network,
  version,
  sources: ["uniswap"],
  tokens: tokens.toSorted((a, b) =>
    String(obj(a)?.["address"]).localeCompare(String(obj(b)?.["address"])),
  ),
});

const evmEntry = (address: string, symbol: string, name: string, decimals: number) => ({
  address: address.toLowerCase(),
  symbol,
  name,
  decimals,
});

const makeEvm = (
  c: PublicClient,
  options: {
    readonly gateway?: typeof GATEWAY | undefined;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
    readonly store?: ReturnType<typeof createMemoryEngineStore>;
  } = {},
) =>
  new AssetsController({
    ownBitcoinTxids: () => new Set(),
    networks: {
      client: () => c,
      info: () => ({ family: "evm", chainId: 1, multicall3: MULTICALL3 }),
    } as never,
    chains,
    openStore: async () => Promise.resolve(options.store ?? createMemoryEngineStore()),
    setTimer: () => () => {},
    logger,
    gateway: options.gateway,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? (() => Date.now()),
  });

describe("AssetsController EVM list discovery", () => {
  it("discovers a listed token with a balance — verified only when decimals match", async () => {
    const calls: Call[] = [];
    const fetches: FetchCall[] = [];
    const c = evmClient(
      new Map<string, TokenStub>([
        [USDC.toLowerCase(), { balance: 5n }],
        [LISTED.toLowerCase(), { balance: 77n, decimals: 6 }],
      ]),
      calls,
    );
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetch(
        [
          {
            status: 200,
            body: listDoc(MAINNET, 7, [
              evmEntry(LISTED, "LST", "Listed Token", 6),
              evmEntry(UNHELD, "NONE", "Unheld Token", 18),
            ]),
            etag: '"v7"',
          },
        ],
        fetches,
      ),
    });
    await assets.init();
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.url).toBe(`${GATEWAY.url}/v1/tokens/${MAINNET}`);
    // Discovery poll: one eth_getBalance plus one aggregate3 holding T+L balanceOf calls.
    expect(calls).toHaveLength(2);
    const agg = decodedAggregate(calls);
    expect(agg.args[0].map((call) => call.target.toLowerCase())).toStrictEqual(
      [USDC, USDT, LISTED, UNHELD].map((a) => a.toLowerCase()),
    );
    expect(agg.args[0].every((call) => call.callData === BALANCE_OF)).toBe(true);
    // Metadata aggregate: decimals only, once, for the held listed token.
    const meta = decodedAggregate(calls, 1);
    expect(meta.args[0].map((call) => call.target.toLowerCase())).toStrictEqual([
      LISTED.toLowerCase(),
    ]);
    expect(meta.args[0].map((call) => call.callData)).toStrictEqual([DECIMALS]);
    const rows = balances.tokens.map((t) => t.address);
    expect(rows).toStrictEqual([USDC, USDT, LISTED]);
    const listed = balances.tokens.find((t) => t.address === LISTED.toLowerCase());
    expect(listed).toStrictEqual({
      address: LISTED.toLowerCase(),
      symbol: "LST",
      name: "Listed Token",
      decimals: 6,
      balance: "77",
      verified: true,
      spam: [],
      hidden: false,
    });
    // A normal poll re-reads the discovered address only — T+D targets, no new metadata.
    calls.length = 0;
    await assets.refresh(OWNER, MAINNET);
    expect(calls).toHaveLength(1);
    const again = decodedAggregate(calls);
    expect(again.args[0].map((call) => call.target.toLowerCase())).toStrictEqual(
      [USDC, USDT, LISTED].map((a) => a.toLowerCase()),
    );
  });

  it("a list token impersonating a table symbol is never eligible for discovery", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map<string, TokenStub>([[FAKER.toLowerCase(), { balance: 9n, decimals: 6 }]]),
      calls,
    );
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetch(
        [{ status: 200, body: listDoc(MAINNET, 1, [evmEntry(FAKER, "USDC", "Fake USD", 6)]) }],
        [],
      ),
    });
    await assets.init();
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT]);
  });

  it("a discovered list token whose decimals differ is unverified, not dropped", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map<string, TokenStub>([[LISTED.toLowerCase(), { balance: 3n, decimals: 8 }]]),
      calls,
    );
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetch(
        [{ status: 200, body: listDoc(MAINNET, 1, [evmEntry(LISTED, "LST", "Listed", 6)]) }],
        [],
      ),
    });
    await assets.init();
    const balances = await assets.refresh(OWNER, MAINNET);
    const listed = balances.tokens.find((t) => t.address === LISTED.toLowerCase());
    expect(listed?.verified).toBe(false);
    expect(listed?.decimals).toBe(8);
  });

  it("no gateway means no discovery — the poll reads tracked tokens only", async () => {
    const calls: Call[] = [];
    const c = evmClient(new Map<string, TokenStub>(), calls);
    const assets = makeEvm(c);
    await assets.init();
    const balances = await assets.refresh(OWNER, MAINNET);
    expect(calls).toHaveLength(1);
    const agg = decodedAggregate(calls);
    expect(agg.args[0]).toHaveLength(2);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT]);
  });
});

describe("TokenLists cache", () => {
  const options = (fetch: typeof globalThis.fetch, now: () => number) => ({
    gateway: GATEWAY,
    fetch,
    setTimer: () => () => {},
    now,
    logger,
  });

  it("fetches once per six hours, sends if-none-match, and keeps entries on 304", async () => {
    const fetches: FetchCall[] = [];
    let now = 1_000_000;
    const fetch = listFetch(
      [
        {
          status: 200,
          body: listDoc(MAINNET, 3, [evmEntry(LISTED, "LST", "Listed Token", 6)]),
          etag: '"v3"',
        },
        { status: 304 },
      ],
      fetches,
    );
    const lists = new TokenLists(options(fetch, () => now));
    await lists.load(createMemoryEngineStore());
    await expect(lists.entries(MAINNET)).resolves.toHaveProperty("size", 1);
    expect(fetches).toHaveLength(1);
    await expect(lists.entries(MAINNET)).resolves.toHaveProperty("size", 1);
    expect(fetches).toHaveLength(1);
    now += 6 * 60 * 60 * 1000 + 1;
    await expect(lists.entries(MAINNET)).resolves.toHaveProperty("size", 1);
    expect(fetches).toHaveLength(2);
    expect(fetches[1]?.headers?.get("if-none-match")).toBe('"v3"');
  });

  it("ignores a version rollback and backs off after failures", async () => {
    const fetches: FetchCall[] = [];
    let now = 0;
    const fetch = listFetch(
      [
        {
          status: 200,
          body: listDoc(MAINNET, 5, [evmEntry(LISTED, "LST", "Listed Token", 6)]),
        },
        { status: 200, body: listDoc(MAINNET, 2, [evmEntry(UNHELD, "OLD", "Old", 6)]) },
      ],
      fetches,
    );
    const lists = new TokenLists(options(fetch, () => now));
    await lists.load(createMemoryEngineStore());
    const first = await lists.entries(MAINNET);
    expect(first.get(LISTED.toLowerCase())?.symbol).toBe("LST");
    now += 6 * 60 * 60 * 1000 + 1;
    const second = await lists.entries(MAINNET);
    expect(second.get(LISTED.toLowerCase())?.symbol).toBe("LST");
    expect(fetches).toHaveLength(2);
    // The rollback set a retry block — no third fetch inside ten minutes.
    now += 60_000;
    await lists.entries(MAINNET);
    expect(fetches).toHaveLength(2);
  });

  it("survives fetch errors with a ten-minute retry block and no gateway at all", async () => {
    const fetches: FetchCall[] = [];
    const now = 0;
    const failing = (async (input: unknown) => {
      fetches.push({ url: String(input) });
      return Promise.reject(new Error("offline"));
    }) as typeof globalThis.fetch;
    const lists = new TokenLists(options(failing, () => now));
    await lists.load(createMemoryEngineStore());
    await expect(lists.entries(MAINNET)).resolves.toHaveProperty("size", 0);
    await lists.entries(MAINNET);
    expect(fetches).toHaveLength(1);
    const none = new TokenLists({ ...options(failing, () => now), gateway: undefined });
    await none.load(createMemoryEngineStore());
    await expect(none.entries(MAINNET)).resolves.toHaveProperty("size", 0);
  });
});

// --- Solana inspection -----------------------------------------------------

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const BONK_PDA = "FDZZbyY9XGpL3CNKUZxLk3wFTTQYL3TkDiDzqxrizcPN";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const PYUSD_PDA = "5mf2C8LGCjkWPb4inZNEjyF8WpXQpfNG2pKgsJqy4Rfg";
const MADLADS = "3yYLEY3gPNHskKfyDZk3JRbDh7uSi1MKB3ffS9GEZXUJ";
const MADLADS_PDA = "CXxbKaC8FmdUrr32AhD2W6G9FgNBN8w2sPWwVuU2JwZV";
const MYSTERY = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";

const mintFixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/solana-mint-accounts.json"), "utf8"),
) as { readonly keys: ReadonlyArray<string>; readonly response: { readonly value: unknown[] } };

/** The recorded mainnet account per key; unscripted keys answer null. */
const mintAccounts = new Map(
  mintFixture.keys.map((key, i) => [key, mintFixture.response.value[i]]),
);

const SOL_OWNER = "Owner1111111111111111111111111111111111111";

const tokenAccount = (mint: string, amount: string, program = PROGRAM_IDS.token) => ({
  // One account per mint: the pubkey derives from the whole mint so no two fixtures collide.
  pubkey: `acct-${mint}`,
  account: {
    owner: program,
    data: {
      parsed: {
        info: {
          mint,
          owner: SOL_OWNER,
          state: "initialized",
          tokenAmount: { amount, decimals: 6 },
        },
        type: "account",
      },
      program: "spl-token",
    },
  },
});

const solRpc = (
  accounts: ReadonlyMap<string, ReadonlyArray<unknown>>,
  calls: Array<{ readonly method: string; readonly params: unknown[] }>,
  extra?: ReadonlyMap<string, unknown>,
  malformed?: { value: boolean },
): SolanaRpc => ({
  call: async (method, params) => {
    calls.push({ method, params });
    if (method === "getBalance") {
      return Promise.resolve({ value: 0 });
    }
    if (method === "getTokenAccountsByOwner") {
      const filter = obj(params[1]) ?? {};
      return Promise.resolve({
        context: { slot: 0 },
        value: [...(accounts.get(String(filter["programId"])) ?? [])],
      });
    }
    if (method === "getMultipleAccounts") {
      const [keys] = params;
      if (malformed?.value === true) {
        return Promise.resolve({ value: [] });
      }
      return Promise.resolve({
        value: (keys as string[]).map((k) => mintAccounts.get(k) ?? extra?.get(k) ?? null),
      });
    }
    return Promise.reject(new Error(`unmocked ${method}`));
  },
});

// Even key positions answer with the mint stub, odd (PDA) positions with null —
// drives batched-mint inspection tests without PDA derivation knowledge.
const solPositionalRpc = (
  accounts: ReadonlyMap<string, ReadonlyArray<unknown>>,
  calls: Array<{ method: string; params: unknown[] }>,
  genericMint: unknown,
): SolanaRpc => ({
  call: async (method, params) => {
    calls.push({ method, params });
    if (method === "getBalance") {
      return Promise.resolve({ value: 0 });
    }
    if (method === "getTokenAccountsByOwner") {
      const filter = obj(params[1]) ?? {};
      return Promise.resolve({
        context: { slot: 0 },
        value: [...(accounts.get(String(filter["programId"])) ?? [])],
      });
    }
    if (method === "getMultipleAccounts") {
      const [keys] = params;
      return Promise.resolve({
        value: (keys as string[]).map((_key, i) => (i % 2 === 0 ? genericMint : null)),
      });
    }
    return Promise.reject(new Error(`unmocked ${method}`));
  },
});

const netInfo = (n: string) =>
  n === SOL_NET ? { family: "solana" } : { family: "evm", chainId: 1 };

const netInfoAll = (n: string) =>
  n === SOL_NET
    ? { family: "solana" }
    : n === "bip122:000000000019d6689c085ae165831e93"
      ? { family: "bitcoin" }
      : { family: "evm", chainId: 1 };

// A fetch whose first call hangs on `pending`, later calls answer 404.
const firstThen404 = (pending: Promise<Response>) => {
  let fetches = 0;
  return (async () => {
    fetches += 1;
    return fetches === 1 ? pending : new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
};

// Latest stored entry for `key`, or `fallback` when the refresh did not store one.
const stateEntry = (
  assets: AssetsController,
  key: string,
  fallback: AccountBalances,
): AccountBalances => assets.getState().balances[key] ?? fallback;

const makeSolana = (
  accounts: ReadonlyMap<string, ReadonlyArray<unknown>>,
  calls: Array<{ readonly method: string; readonly params: unknown[] }>,
  store = createMemoryEngineStore(),
  extra?: ReadonlyMap<string, unknown>,
  opts?: {
    readonly gateway?: typeof GATEWAY;
    readonly fetch?: typeof globalThis.fetch;
    readonly malformed?: { value: boolean };
  },
) =>
  new AssetsController({
    ownBitcoinTxids: () => new Set(),
    networks: {
      info: (n: string) => (n === SOL_NET ? { family: "solana" } : { family: "evm", chainId: 1 }),
      solanaRpc: () => solRpc(accounts, calls, extra, opts?.malformed),
    } as never,
    chains,
    openStore: async () => Promise.resolve(store),
    setTimer: () => () => {},
    logger,
    gateway: opts?.gateway,
    fetch: opts?.fetch ?? globalThis.fetch,
    now: () => Date.now(),
  });

describe("AssetsController solana mint inspection", () => {
  const accounts = new Map([
    [
      PROGRAM_IDS.token,
      [tokenAccount(BONK, "100"), tokenAccount(MADLADS, "1"), tokenAccount(MYSTERY, "42")],
    ],
    [PROGRAM_IDS.token2022, [tokenAccount(PYUSD, "50", PROGRAM_IDS.token2022)]],
  ]);

  it("shows held unknown mints — BONK from its real Metaplex PDA, PYUSD from Token-2022 metadata", async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const mysteryMint = {
      lamports: 1,
      owner: PROGRAM_IDS.token,
      executable: false,
      rentEpoch: 0,
      space: 82,
      data: {
        parsed: {
          type: "mint",
          info: { decimals: 6, supply: "999", isInitialized: true },
        },
        program: "spl-token",
      },
    };
    const assets = makeSolana(accounts, calls, undefined, new Map([[MYSTERY, mysteryMint]]));
    await assets.init();
    const balances = await assets.refresh(SOL_OWNER, SOL_NET);
    const inspect = calls.filter((c) => c.method === "getMultipleAccounts");
    expect(inspect).toHaveLength(1);
    // The request pairs each mint with its Metaplex PDA — the recorded mainnet addresses.
    expect(inspect[0]?.params[0]).toStrictEqual([
      PYUSD,
      PYUSD_PDA,
      MADLADS,
      MADLADS_PDA,
      MYSTERY,
      expect.any(String),
      BONK,
      BONK_PDA,
    ]);
    const bonk = balances.tokens.find((t) => t.address === BONK);
    expect(bonk).toMatchObject({
      symbol: "Bonk",
      name: "Bonk",
      decimals: 5,
      balance: "100",
      verified: false,
      spam: [],
      hidden: false,
    });
    const pyusd = balances.tokens.find((t) => t.address === PYUSD);
    // Token-2022 tokenMetadata wins; the permanentDelegate extension is a spam reason.
    expect(pyusd).toMatchObject({
      symbol: "PYUSD",
      name: "PayPal USD",
      decimals: 6,
      balance: "50",
      verified: false,
      hidden: true,
    });
    expect(pyusd?.spam).toStrictEqual(["permanent-delegate"]);
    // The Mad Lads NFT (decimals 0, supply 1) is omitted; the symbol-less mint shows "?".
    expect(balances.tokens.find((t) => t.address === MADLADS)).toBeUndefined();
    expect(balances.tokens.find((t) => t.address === MYSTERY)?.symbol).toBe("?");
    // Facts and "missing" are cached for the unlock — the next poll asks nothing.
    calls.length = 0;
    await assets.refresh(SOL_OWNER, SOL_NET);
    expect(calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(0);
  });

  it("a spam-flagged mint stays hidden until explicitly shown — the verdict persists", async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const store = createMemoryEngineStore();
    const assets = makeSolana(accounts, calls, store);
    await assets.init();
    const balances = await assets.refresh(SOL_OWNER, SOL_NET);
    expect(balances.tokens.find((t) => t.address === PYUSD)?.hidden).toBe(true);
    await assets.setTokenHidden(SOL_NET, PYUSD, false);
    const shown = await assets.refresh(SOL_OWNER, SOL_NET);
    expect(shown.tokens.find((t) => t.address === PYUSD)?.hidden).toBe(false);
    const raw = await store.collection("assets-custom-tokens").get("visibility");
    expect(decodeStore(raw)).toStrictEqual({
      [SOL_NET]: { [PYUSD]: "shown" },
    });
    const fresh = makeSolana(accounts, [], store);
    await fresh.init();
    const persisted = await fresh.refresh(SOL_OWNER, SOL_NET);
    expect(persisted.tokens.find((t) => t.address === PYUSD)?.hidden).toBe(false);
  });
});

// --- Custom-as-list, impersonation, chunking, cadence ------------------------

const listFetchOnce = (network: string, version: number, tokens: ReadonlyArray<unknown>) =>
  listFetch([{ status: 200, body: listDoc(network, version, tokens) }], []);

describe("AssetsController EVM customs that are also list entries", () => {
  it("a custom token that is an eligible list entry shows list metadata, verified, not hidden", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map([[CUSTOM.toLowerCase(), { balance: 9n, symbol: "TST", decimals: 6 }]]),
      calls,
    );
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetchOnce(MAINNET, 1, [evmEntry(CUSTOM, "LST", "Listed Token", 6)]),
    });
    await assets.init();
    await assets.addToken(MAINNET, CUSTOM);
    const balances = await assets.refresh(OWNER, MAINNET);
    const rows = balances.tokens.map((t) => t.address);
    expect(rows).toStrictEqual([USDC, USDT, CUSTOM]);
    expect(balances.tokens[2]).toStrictEqual({
      address: CUSTOM,
      symbol: "LST",
      name: "Listed Token",
      decimals: 6,
      balance: "9",
      verified: true,
      spam: [],
      hidden: false,
    });
  });

  it("a custom list token whose decimals mismatch is unverified — but never an impersonator", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map([[CUSTOM.toLowerCase(), { balance: 9n, symbol: "TST", decimals: 6 }]]),
      calls,
    );
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetchOnce(MAINNET, 1, [evmEntry(CUSTOM, "LST", "Listed Token", 8)]),
    });
    await assets.init();
    await assets.addToken(MAINNET, CUSTOM);
    const balances = await assets.refresh(OWNER, MAINNET);
    const token = balances.tokens.find((t) => t.address === CUSTOM);
    expect(token?.verified).toBe(false);
    expect(token?.spam).toStrictEqual([]);
    expect(token?.hidden).toBe(false);
  });

  it("a different address carrying a list token's symbol is an impersonator and hidden", async () => {
    const calls: Call[] = [];
    const c = evmClient(
      new Map([[FAKER.toLowerCase(), { balance: 9n, symbol: "LST", decimals: 6 }]]),
      calls,
    );
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetchOnce(MAINNET, 1, [evmEntry(LISTED, "LST", "Listed Token", 6)]),
    });
    await assets.init();
    await assets.addToken(MAINNET, FAKER);
    const balances = await assets.refresh(OWNER, MAINNET);
    const fake = balances.tokens.find((t) => t.address === FAKER);
    expect(fake?.verified).toBe(false);
    expect(fake?.spam).toStrictEqual(["impersonation"]);
    expect(fake?.hidden).toBe(true);
  });
});

describe("AssetsController EVM aggregate chunking", () => {
  it("489 targets split into aggregate3 calls of 300 and 189, answers mapped in order", async () => {
    const calls: Call[] = [];
    const addresses: Array<`0x${string}`> = Array.from(
      { length: 487 },
      (_, i): `0x${string}` => `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    const stubs = new Map<string, TokenStub>([
      [USDC.toLowerCase(), { balance: 1n }],
      [addresses[297]!.toLowerCase(), { balance: 3n, decimals: 6 }],
      [addresses[298]!.toLowerCase(), { balance: 4n, decimals: 6 }],
      [addresses[486]!.toLowerCase(), { balance: 5n, decimals: 6 }],
    ]);
    const c = evmClient(stubs, calls);
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetchOnce(
        MAINNET,
        1,
        addresses.map((a, i) => evmEntry(a, `T${i}`, `Token ${i}`, 6)),
      ),
    });
    await assets.init();
    const balances = await assets.refresh(OWNER, MAINNET);
    // Two balance aggregates (300 + 189 targets), then one metadata aggregate for the three held.
    expect(calls).toHaveLength(3);
    expect(decodedAggregate(calls, 0).args[0]).toHaveLength(300);
    expect(decodedAggregate(calls, 1).args[0]).toHaveLength(189);
    const meta = decodedAggregate(calls, 2);
    const held: ReadonlyArray<`0x${string}`> = [addresses[297]!, addresses[298]!, addresses[486]!];
    expect(meta.args[0].map((call) => call.target.toLowerCase()).toSorted()).toStrictEqual(
      held.map((a) => a.toLowerCase()).toSorted(),
    );
    expect(balances.tokens.filter((t) => !t.verified)).toHaveLength(0);
    expect(balances.tokens.filter((t) => t.spam.length > 0)).toHaveLength(0);
    for (const addr of held) {
      const row = balances.tokens.find((t) => t.address === addr.toLowerCase());
      expect(row?.verified).toBe(true);
      expect(Number(row?.balance)).toBeGreaterThan(0);
    }
  });
});

describe("AssetsController EVM discovery cadence", () => {
  it("re-scans the list every ten minutes; zero-balance discoveries drop out", async () => {
    const calls: Call[] = [];
    let now = 1_000_000;
    const stubs = new Map<string, TokenStub>([[LISTED.toLowerCase(), { decimals: 6 }]]);
    const c = evmClient(stubs, calls);
    const assets = makeEvm(c, {
      gateway: GATEWAY,
      fetch: listFetchOnce(MAINNET, 1, [evmEntry(LISTED, "LST", "Listed", 6)]),
      now: () => now,
    });
    await assets.init();
    let balances = await assets.refresh(OWNER, MAINNET);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT]);

    // The token gains a balance between scans — a +9 min poll reads tracked+discovered only.
    stubs.set(LISTED.toLowerCase(), { balance: 11n, decimals: 6 });
    now += 9 * 60_000;
    calls.length = 0;
    balances = await assets.refresh(OWNER, MAINNET);
    expect(decodedAggregate(calls).args[0].map((call) => call.target)).toStrictEqual([USDC, USDT]);
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT]);

    // The +10 min poll re-scans the whole list and finds it.
    now += 2 * 60_000;
    calls.length = 0;
    balances = await assets.refresh(OWNER, MAINNET);
    expect(decodedAggregate(calls).args[0].map((call) => call.target.toLowerCase())).toStrictEqual(
      [USDC, USDT, LISTED].map((a) => a.toLowerCase()),
    );
    expect(balances.tokens.find((t) => t.address === LISTED.toLowerCase())?.verified).toBe(true);

    // It drops to zero — the next poll reads it once, reports nothing, and forgets it.
    stubs.set(LISTED.toLowerCase(), { decimals: 6 });
    now += 60_000;
    calls.length = 0;
    balances = await assets.refresh(OWNER, MAINNET);
    expect(decodedAggregate(calls).args[0].map((call) => call.target.toLowerCase())).toStrictEqual(
      [USDC, USDT, LISTED].map((a) => a.toLowerCase()),
    );
    expect(balances.tokens.map((t) => t.address)).toStrictEqual([USDC, USDT]);
    calls.length = 0;
    await assets.refresh(OWNER, MAINNET);
    expect(decodedAggregate(calls).args[0].map((call) => call.target)).toStrictEqual([USDC, USDT]);
  });
});

// --- Solana lists, reasons, batching ---------------------------------------

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** A synthetic jsonParsed Token-2022 mint account — not a recorded account. */
const t22Mint = (opts: {
  readonly decimals: number;
  readonly supply?: string;
  readonly symbol?: string;
  readonly name?: string;
  readonly nonTransferable?: boolean;
}): unknown => ({
  lamports: 1,
  owner: T22,
  executable: false,
  rentEpoch: 0,
  space: 200,
  data: {
    parsed: {
      type: "mint",
      info: {
        decimals: opts.decimals,
        supply: opts.supply ?? "999999",
        isInitialized: true,
        extensions: [
          ...(opts.symbol === undefined && opts.name === undefined
            ? []
            : [
                {
                  extension: "tokenMetadata",
                  state: {
                    symbol: opts.symbol ?? "TKN",
                    name: opts.name ?? "Token",
                    mint: "",
                    updateAuthority: null,
                  },
                },
              ]),
          ...(opts.nonTransferable === true ? [{ extension: "nonTransferable" }] : []),
        ],
      },
      program: "spl-token-2022",
    },
  },
});

describe("AssetsController solana lists, reasons and batching", () => {
  const LISTED_MINT = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
  const FAKE_MINT = "9coHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKi";
  const LINK_MINT = "7aoHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKk";
  const NT_MINT = "6boHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKj";

  const solEntry = (address: string, symbol: string, name: string, decimals: number) => ({
    address,
    symbol,
    name,
    decimals,
  });

  it("a custom mint that is a list entry is verified; a lookalike mint is an impersonator", async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const accounts = new Map([
      [PROGRAM_IDS.token, []],
      [
        PROGRAM_IDS.token2022,
        [
          tokenAccount(LISTED_MINT, "10", PROGRAM_IDS.token2022),
          tokenAccount(FAKE_MINT, "20", PROGRAM_IDS.token2022),
        ],
      ],
    ]);
    const extra = new Map<string, unknown>([
      [LISTED_MINT, t22Mint({ decimals: 6, symbol: "JST", name: "Just Token" })],
      [FAKE_MINT, t22Mint({ decimals: 6, symbol: "JST", name: "Fake Just" })],
    ]);
    const assets = makeSolana(accounts, calls, undefined, extra, {
      gateway: GATEWAY,
      fetch: listFetchOnce(SOL_NET, 1, [solEntry(LISTED_MINT, "JST", "Just Token", 6)]),
    });
    await assets.init();
    await assets.addToken(SOL_NET, LISTED_MINT);
    await assets.addToken(SOL_NET, FAKE_MINT);
    const balances = await assets.refresh(SOL_OWNER, SOL_NET);
    const listed = balances.tokens.find((t) => t.address === LISTED_MINT);
    expect(listed).toMatchObject({
      symbol: "JST",
      name: "Just Token",
      decimals: 6,
      verified: true,
      spam: [],
      hidden: false,
    });
    const fake = balances.tokens.find((t) => t.address === FAKE_MINT);
    expect(fake?.verified).toBe(false);
    expect(fake?.spam).toStrictEqual(["impersonation"]);
    expect(fake?.hidden).toBe(true);
  });

  it("mints carrying link-in-name or nonTransferable flag their reasons", async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const accounts = new Map([
      [PROGRAM_IDS.token, []],
      [
        PROGRAM_IDS.token2022,
        [
          tokenAccount(LINK_MINT, "5", PROGRAM_IDS.token2022),
          tokenAccount(NT_MINT, "5", PROGRAM_IDS.token2022),
        ],
      ],
    ]);
    const extra = new Map<string, unknown>([
      [LINK_MINT, t22Mint({ decimals: 6, symbol: "OK", name: "Claim now at free-tokens.io" })],
      [NT_MINT, t22Mint({ decimals: 6, symbol: "NT", name: "Soulbound", nonTransferable: true })],
    ]);
    const assets = makeSolana(accounts, calls, undefined, extra);
    await assets.init();
    const balances = await assets.refresh(SOL_OWNER, SOL_NET);
    expect(balances.tokens.find((t) => t.address === LINK_MINT)?.spam).toStrictEqual([
      "link-in-name",
    ]);
    expect(balances.tokens.find((t) => t.address === NT_MINT)?.spam).toStrictEqual([
      "non-transferable",
    ]);
  });

  it("inspects at most 50 mints per refresh — 120 held mints finish in three reads", async () => {
    const decode = getAddressDecoder();
    const mints = Array.from({ length: 120 }, (_, i) => {
      const bytes = new Uint8Array(32);
      bytes[0] = i % 256;
      bytes[1] = Math.floor(i / 256);
      return decode.decode(bytes);
    }).toSorted();
    const genericMint = {
      lamports: 1,
      owner: PROGRAM_IDS.token,
      executable: false,
      rentEpoch: 0,
      space: 82,
      data: {
        parsed: {
          type: "mint",
          info: { decimals: 6, supply: "999999", isInitialized: true },
        },
        program: "spl-token",
      },
    };
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const accounts = new Map<string, ReadonlyArray<unknown>>([
      [PROGRAM_IDS.token, mints.map((mint) => tokenAccount(mint, "1"))],
      [PROGRAM_IDS.token2022, []],
    ]);
    // Every even key position is a mint, every odd one its PDA — always a generic mint + null.
    const assets = new AssetsController({
      ownBitcoinTxids: () => new Set(),
      networks: {
        info: netInfo,
        solanaRpc: () => solPositionalRpc(accounts, calls, genericMint),
      } as never,
      chains,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: () => () => {},
      logger,
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await assets.init();
    const shown = async () => {
      const balances = await assets.refresh(SOL_OWNER, SOL_NET);
      return balances.tokens.length;
    };
    const inspect = () => calls.filter((c) => c.method === "getMultipleAccounts");
    await expect(shown()).resolves.toBe(52); // 2 table mints + first 50 unknown
    expect(inspect()).toHaveLength(1);
    expect(inspect()[0]?.params[0]).toHaveLength(100);
    await expect(shown()).resolves.toBe(102);
    expect(inspect()).toHaveLength(2);
    expect(inspect()[1]?.params[0]).toHaveLength(100);
    await expect(shown()).resolves.toBe(122);
    expect(inspect()).toHaveLength(3);
    expect(inspect()[2]?.params[0]).toHaveLength(40);
    await expect(shown()).resolves.toBe(122);
    expect(inspect()).toHaveLength(3);
  });

  it("a malformed getMultipleAccounts answer fails the refresh — nothing is cached", async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const malformed = { value: true };
    const accounts = new Map([
      [PROGRAM_IDS.token, [tokenAccount(BONK, "100")]],
      [PROGRAM_IDS.token2022, []],
    ]);
    const assets = makeSolana(accounts, calls, undefined, undefined, { malformed });
    await assets.init();
    await expect(assets.refresh(SOL_OWNER, SOL_NET)).rejects.toThrow("malformed");
    expect(calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
    // Nothing was cached as missing — a healthy answer is asked about the mint again.
    malformed.value = false;
    const balances = await assets.refresh(SOL_OWNER, SOL_NET);
    expect(calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(2);
    expect(balances.tokens.find((t) => t.address === BONK)?.symbol).toBe("Bonk");
  });
});

// --- TokenLists resilience ---------------------------------------------------

describe("TokenLists resilience", () => {
  const options = (fetch: typeof globalThis.fetch, now: () => number) => ({
    gateway: GATEWAY,
    fetch,
    setTimer: () => () => {},
    now,
    logger,
  });

  it("a 404 caches the empty list for six hours", async () => {
    const fetches: FetchCall[] = [];
    let now = 0;
    const lists = new TokenLists(options(listFetch([{ status: 404 }], fetches), () => now));
    await lists.load(createMemoryEngineStore());
    await expect(lists.entries(MAINNET)).resolves.toHaveProperty("size", 0);
    now += 60_000;
    await expect(lists.entries(MAINNET)).resolves.toHaveProperty("size", 0);
    expect(fetches).toHaveLength(1);
  });

  it("an invalid body or foreign network is warned away, the stored list kept", async () => {
    const fetches: FetchCall[] = [];
    const warnings: string[] = [];
    let now = 0;
    const fetch = listFetch(
      [
        {
          status: 200,
          body: listDoc(MAINNET, 5, [evmEntry(LISTED, "LST", "Listed Token", 6)]),
        },
        { status: 200, body: { not: "a list" } },
        { status: 200, body: listDoc("eip155:10", 9, []) },
      ],
      fetches,
    );
    const lists = new TokenLists({
      ...options(fetch, () => now),
      logger: { warn: (line: string) => warnings.push(line) },
    });
    await lists.load(createMemoryEngineStore());
    const first = await lists.entries(MAINNET);
    expect(first.get(LISTED.toLowerCase())?.symbol).toBe("LST");
    now += 6 * 60 * 60 * 1000 + 1;
    const second = await lists.entries(MAINNET);
    expect(second.get(LISTED.toLowerCase())?.symbol).toBe("LST");
    expect(warnings).toHaveLength(1);
    // The failure blocked retries for ten minutes — no third fetch even though still stale.
    await lists.entries(MAINNET);
    expect(fetches).toHaveLength(2);
    // Past the block it asks again and rejects a foreign-network answer the same way.
    now += 11 * 60_000;
    const third = await lists.entries(MAINNET);
    expect(third.get(LISTED.toLowerCase())?.symbol).toBe("LST");
    expect(warnings).toHaveLength(2);
  });

  it("a persisted list survives clear + load and is used offline while fresh", async () => {
    const fetches: FetchCall[] = [];
    const store = createMemoryEngineStore();
    const fetch = listFetch(
      [
        {
          status: 200,
          body: listDoc(MAINNET, 5, [evmEntry(LISTED, "LST", "Listed Token", 6)]),
        },
      ],
      fetches,
    );
    const now = () => Date.now();
    const lists = new TokenLists(options(fetch, now));
    await lists.load(store);
    await lists.entries(MAINNET);
    expect(fetches).toHaveLength(1);
    lists.clear();
    const fresh = new TokenLists(options(fetch, now));
    await fresh.load(store);
    const entries = await fresh.entries(MAINNET);
    expect(entries.get(LISTED.toLowerCase())?.symbol).toBe("LST");
    expect(fetches).toHaveLength(1);
  });

  it("a refresh resolved after clear() repopulates nothing", async () => {
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const lists = new TokenLists(options(firstThen404(pending), () => Date.now()));
    const store = createMemoryEngineStore();
    await lists.load(store);
    const inflight = lists.entries(MAINNET);
    lists.clear();
    release(Response.json(listDoc(MAINNET, 1, [evmEntry(LISTED, "LST", "Listed", 6)])));
    await inflight;
    const raw = await store.collection("token-lists").get(MAINNET);
    expect(raw).toBeUndefined();
    await expect(lists.entries(MAINNET)).resolves.toHaveProperty("size", 0);
  });

  it("requests carry the family client id — evm for eip155, solana for solana", async () => {
    let i = 0;
    const session = gatewaySession(GATEWAY.url, (n) =>
      new Uint8Array(n).map(() => {
        i += 1;
        return i;
      }),
    );
    const fetches: FetchCall[] = [];
    const fetch = listFetch(
      [
        {
          status: 200,
          body: listDoc(MAINNET, 1, [evmEntry(LISTED, "LST", "Listed", 6)]),
        },
        { status: 200, body: { network: SOL_NET, version: 1, sources: ["jupiter"], tokens: [] } },
      ],
      fetches,
    );
    const withSession = new TokenLists({ ...options(fetch, () => Date.now()), gateway: session });
    await withSession.load(createMemoryEngineStore());
    await withSession.entries(MAINNET);
    await withSession.entries(SOL_NET);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]?.headers?.get("x-client-id")).toBe(session.clientIds.evm);
    expect(fetches[1]?.headers?.get("x-client-id")).toBe(session.clientIds.solana);
  });
});

// --- Visibility verdicts and price holdings -----------------------------------

describe("AssetsController visibility and prices", () => {
  it("hidden tokens stay out of heldAssets and groupHoldings; a shown verdict restores them", async () => {
    const { heldAssets, groupHoldings } = await import("../src/prices/holdings.ts");
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const accounts = new Map([
      [PROGRAM_IDS.token, []],
      [PROGRAM_IDS.token2022, [tokenAccount(PYUSD, "50", PROGRAM_IDS.token2022)]],
    ]);
    const assets = makeSolana(accounts, calls);
    await assets.init();
    const key = `${SOL_NET}:${SOL_OWNER}`;
    const refresh = async () => {
      const b = await assets.refresh(SOL_OWNER, SOL_NET);
      return stateEntry(assets, key, b);
    };
    let entry = await refresh();
    expect(entry.tokens.find((t) => t.address === PYUSD)?.hidden).toBe(true);
    const wanted = (extra: string[] = []) =>
      [
        `${SOL_NET}/slip44:501`,
        `${SOL_NET}/token:${SOL_USDC}`,
        `${SOL_NET}/token:${SOL_USDT}`,
        ...extra,
      ].toSorted();
    expect(heldAssets({ [key]: entry }, {}, "mainnet")).toStrictEqual(wanted());
    const groups = groupHoldings({
      balances: { [key]: entry },
      spark: {},
      sparkNetwork: "mainnet",
      group: { walletId: "w", groupIndex: 0 },
      addresses: [{ network: SOL_NET, address: SOL_OWNER }],
      bitcoin: [],
    });
    expect(groups.some((h) => h.asset?.endsWith(PYUSD))).toBe(false);
    await assets.setTokenHidden(SOL_NET, PYUSD, false);
    entry = await refresh();
    expect(entry.tokens.find((t) => t.address === PYUSD)?.hidden).toBe(false);
    expect(heldAssets({ [key]: entry }, {}, "mainnet")).toStrictEqual(
      wanted([`${SOL_NET}/token:${PYUSD}`]),
    );
  });

  it("setTokenHidden rejects malformed addresses and tokenless networks", async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown[] }> = [];
    const assets = new AssetsController({
      ownBitcoinTxids: () => new Set(),
      networks: {
        info: netInfoAll,
        solanaRpc: () => solRpc(new Map(), calls),
      } as never,
      chains,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: () => () => {},
      logger,
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await assets.init();
    await expect(assets.setTokenHidden(MAINNET, "not-hex", true)).rejects.toThrow(TypeError);
    await expect(assets.setTokenHidden(SOL_NET, "0xbad", true)).rejects.toThrow(TypeError);
    await expect(
      assets.setTokenHidden("bip122:000000000019d6689c085ae165831e93", PYUSD, true),
    ).rejects.toThrow("no tokens");
  });
});
