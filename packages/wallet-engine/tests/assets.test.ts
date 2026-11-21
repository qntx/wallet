import { encodeFunctionData, encodeFunctionResult } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import { AssetsController } from "../src/assets/controller.ts";
import { MULTICALL3_ABI } from "../src/assets/evm.ts";
import { ERC20_ABI, EvmChainAdapter } from "../src/chains/evm.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { manualTimers } from "./support/timers.ts";

const client = (handlers: Record<string, unknown>): PublicClient =>
  ({
    transport: {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        const v = handlers[method];
        return method in handlers
          ? Promise.resolve(typeof v === "function" ? (v as (p?: unknown[]) => unknown)(params) : v)
          : Promise.reject(new Error(`unmocked ${method}`));
      },
    },
  }) as unknown as PublicClient;

const logger = { warn: () => {} };

const TOKEN = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OWNER = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// chainId 1 built-ins, in table order — every refresh on this network tracks them.
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as `0x${string}`;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`;

const balOf = encodeFunctionData({
  abi: ERC20_ABI,
  functionName: "balanceOf",
  args: [OWNER],
});
const enc = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;

const ethCall =
  (responses: Record<string, string>, onCall?: () => void): ((params?: unknown[]) => string) =>
  (params) => {
    onCall?.();
    const [{ data }] = (params ?? [{}]) as [{ data?: string }];
    return responses[data ?? ""] ?? enc(0n);
  };

const AGG = (callData: `0x${string}`): string =>
  encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [[USDC, USDT, WETH, TOKEN].map((target) => ({ target, allowFailure: true, callData }))],
  });

const SYMBOL_CALL = encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" });
const DECIMALS_CALL = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" });

/** The metadata batch for the added token: decimals and symbol inside one aggregate3. */
const AGG_META = encodeFunctionData({
  abi: MULTICALL3_ABI,
  functionName: "aggregate3",
  args: [
    [
      { target: TOKEN, allowFailure: true, callData: DECIMALS_CALL },
      { target: TOKEN, allowFailure: true, callData: SYMBOL_CALL },
    ],
  ],
});

const fakeNetworks = (c: PublicClient, multicall3?: string) =>
  ({
    client: () => c,
    info: () => ({ family: "evm", chainId: 1, multicall3 }),
  }) as never;

const chains = {
  account: async () => Promise.reject(new Error("unmocked chains.account")),
};

const controller = (c: PublicClient, multicall3?: string) =>
  new AssetsController({
    ownBitcoinTxids: () => new Set(),
    networks: fakeNetworks(c, multicall3),
    chains,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger,
    gateway: undefined,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  });

describe("EvmChainAdapter erc20", () => {
  it("encodes transfer calldata, to=token, value=0, gas=estimate×1.1", async () => {
    const a = new EvmChainAdapter();
    const c = client({ eth_getTransactionCount: "0x0", eth_estimateGas: "0x10000" });
    const tx = await a.build(
      c,
      "eip155:1",
      OWNER,
      {
        kind: "erc20",
        token: TOKEN,
        to: "0x3333333333333333333333333333333333333333",
        value: 7n,
      },
      0,
    );
    expect(tx.to).toBe(TOKEN);
    expect(tx.value).toBe(0n);
    expect(tx.data).toBe(
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: ["0x3333333333333333333333333333333333333333", 7n],
      }),
    );
    expect(tx.gas).toBe((65536n * 11n + 9n) / 10n);
  });
});

describe("AssetsController", () => {
  it("reads native + token balances via multicall3 (one eth_call) and per-token without it", async () => {
    let calls = 0;
    const c = client({
      eth_getBalance: "0xde0b6b3a7640000",
      eth_call: ethCall(
        {
          [balOf]: enc(5n),
          [AGG(balOf)]: encodeFunctionResult({
            abi: MULTICALL3_ABI,
            functionName: "aggregate3",
            result: [
              { success: true, returnData: enc(5n) as `0x${string}` },
              { success: true, returnData: enc(7n) as `0x${string}` },
              { success: true, returnData: enc(11n) as `0x${string}` },
              { success: true, returnData: enc(5n) as `0x${string}` },
            ],
          }),
          [AGG_META]: encodeFunctionResult({
            abi: MULTICALL3_ABI,
            functionName: "aggregate3",
            result: [
              { success: true, returnData: enc(6n) as `0x${string}` },
              {
                success: true,
                returnData: encodeFunctionResult({
                  abi: ERC20_ABI,
                  functionName: "symbol",
                  result: "TST",
                }),
              },
            ],
          }),
          [SYMBOL_CALL]: encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "symbol",
            result: "TST",
          }),
          [DECIMALS_CALL]: enc(6n),
        },
        () => {
          calls += 1;
        },
      ),
    });
    const assets = controller(c, MULTICALL3);
    await assets.init();
    await assets.addToken("eip155:1", TOKEN);
    calls = 0;
    await assets.refresh(OWNER, "eip155:1");
    const s = assets.getState().balances[`eip155:1:${OWNER}`];
    expect(s?.native).toBe("1000000000000000000");
    // built-ins read through the same aggregate3; the added token stays last, unverified
    expect(s?.tokens).toHaveLength(4);
    expect(s?.tokens[0]?.verified).toBe(true);
    const tst = s?.tokens[3];
    expect(tst?.address).toBe(TOKEN);
    expect(tst?.balance).toBe("5");
    expect(tst?.symbol).toBe("TST");
    expect(tst?.decimals).toBe(6);
    expect(tst?.verified).toBe(false);
    // one aggregate3 for all balances — the custom's symbol/decimals were read at addToken.
    expect(calls).toBe(1);

    const c2 = client({
      eth_getBalance: "0x0",
      eth_call: ethCall({
        [balOf]: enc(9n),
        [SYMBOL_CALL]: encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "symbol",
          result: "TST",
        }),
        [DECIMALS_CALL]: enc(6n),
      }),
    });
    const assets2 = controller(c2);
    await assets2.init();
    await assets2.addToken("eip155:1", TOKEN);
    await assets2.refresh(OWNER, "eip155:1");
    const tokens2 = assets2.getState().balances[`eip155:1:${OWNER}`]?.tokens;
    expect(tokens2?.find((t) => t.address === TOKEN)?.balance).toBe("9");
  });

  it("persists custom tokens across init and polls only while visible", async () => {
    const store = createMemoryEngineStore();
    const c = client({
      eth_getBalance: "0x0",
      eth_call: ethCall({
        [balOf]: enc(1n),
        [SYMBOL_CALL]: encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "symbol",
          result: "TST",
        }),
        [DECIMALS_CALL]: enc(6n),
      }),
    });
    const timers = manualTimers();
    const mk = () =>
      new AssetsController({
        ownBitcoinTxids: () => new Set(),
        networks: fakeNetworks(c),
        chains,
        openStore: async () => Promise.resolve(store),
        setTimer: timers.setTimer,
        logger,
        gateway: undefined,
        fetch: globalThis.fetch,
        now: () => Date.now(),
      });
    const assets = mk();
    await assets.init();
    await assets.addToken("eip155:1", TOKEN);
    const fresh = mk();
    await fresh.init();
    fresh.setVisible(true);
    expect(timers.armed()).toBe(1);
    await fresh.refresh(OWNER, "eip155:1");
    await timers.fire();
    fresh.setVisible(false);
    fresh.lock();
    expect(fresh.getState().balances).toStrictEqual({});
  });
});

const solRpc = (handlers: Record<string, unknown>): SolanaRpc => ({
  call: async (method, params) => {
    const v = handlers[method];
    return method in handlers
      ? Promise.resolve(typeof v === "function" ? (v as (p?: unknown[]) => unknown)(params) : v)
      : Promise.reject(new Error(`unmocked ${method}`));
  },
});

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_OWNER = "Owner1111111111111111111111111111111111111";
// PYUSD — a real Token-2022 mint on mainnet.
const T22_MINT = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
// A token account owned by the Token-2022 program (TokenzQd...) holding 7 raw units.
const T22_ACCOUNT = {
  pubkey: "Ata2022zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  account: {
    owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    data: {
      parsed: {
        info: {
          mint: T22_MINT,
          owner: SOL_OWNER,
          state: "initialized",
          tokenAmount: { amount: "7", decimals: 6 },
        },
        type: "account",
      },
      program: "spl-token-2022",
    },
  },
};

const solNetInfo = (n: string) => (n === SOL_NET ? { family: "solana" } : { family: "evm" });

const T22_MINT_ACCOUNT = {
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: {
    parsed: {
      type: "mint",
      info: { decimals: 6, supply: "1000000" },
    },
    program: "spl-token-2022",
  },
};

const t22Multi = (params?: unknown[]) => ({
  value: ((params?.[0] ?? []) as string[]).map((mint) =>
    mint === T22_MINT ? T22_MINT_ACCOUNT : null,
  ),
});

/** The program-filtered account answer: the wallet's one Token-2022 account, nothing else. */
const t22Accounts = (params?: unknown[]) => {
  const filter = (params?.[1] ?? {}) as Record<string, unknown>;
  return { value: filter["programId"] === PROGRAM_IDS.token2022 ? [T22_ACCOUNT] : [] };
};

const balancesOf = (ctl: AssetsController, k: string) => {
  const entry = ctl.getState().balances[k];
  if (entry === undefined) {
    throw new Error(`no balance entry for ${k}`);
  }
  return entry;
};

describe("AssetsController token tracking", () => {
  const symbolCall = encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" });
  const decimalsCall = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" });
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("tracks built-in tokens case-insensitively, custom tokens once added, and nothing else", async () => {
    const c = client({
      eth_call: ethCall({
        [symbolCall]: encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "symbol",
          result: "TST",
        }),
        [decimalsCall]: enc(6n),
      }),
    });
    const ctl = controller(c);
    await ctl.init();
    expect(ctl.isTracked("eip155:1", USDC)).toBe(true);
    expect(ctl.isTracked("eip155:1", USDC.toLowerCase())).toBe(true);
    expect(ctl.isTracked("eip155:1", TOKEN)).toBe(false);
    await ctl.addToken("eip155:1", TOKEN);
    expect(ctl.isTracked("eip155:1", TOKEN.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("reads symbol and decimals on-chain", async () => {
    const c = client({
      eth_call: ethCall({
        [symbolCall]: encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "symbol",
          result: "TST",
        }),
        [decimalsCall]: enc(6n),
      }),
    });
    await expect(controller(c).tokenMetadata("eip155:1", TOKEN)).resolves.toStrictEqual({
      symbol: "TST",
      decimals: 6,
    });
  });

  it("throws when either read does not decode", async () => {
    const c = client({ eth_call: "0x" });
    await expect(controller(c).tokenMetadata("eip155:1", TOKEN)).rejects.toThrow(
      "not a readable ERC-20",
    );
  });
});

describe("AssetsController solana", () => {
  it("reports a Token-2022 token account in balances (program-filtered query covers it)", async () => {
    const r = solRpc({
      getBalance: { value: 5_000_000 },
      getMultipleAccounts: t22Multi,
      getTokenAccountsByOwner: t22Accounts,
    });
    const ctl = new AssetsController({
      ownBitcoinTxids: () => new Set(),
      networks: {
        info: solNetInfo,
        solanaRpc: () => r,
      } as never,
      chains,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: () => () => {},
      logger,
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await ctl.init();
    await ctl.addToken(SOL_NET, T22_MINT);
    await ctl.refresh(SOL_OWNER, SOL_NET);
    const entry = balancesOf(ctl, `${SOL_NET}:${SOL_OWNER}`);
    expect(entry.native).toBe("5000000");
    const tok = entry.tokens.find((t) => t.address === T22_MINT);
    expect(tok?.balance).toBe("7");
    expect(tok?.decimals).toBe(6);
  });
});

describe("AssetsController polling", () => {
  it("re-reads every tracked account with its own network and address", async () => {
    const evmReads: unknown[] = [];
    const solReads: unknown[] = [];
    const timers = manualTimers();
    const ctl = new AssetsController({
      ownBitcoinTxids: () => new Set(),
      networks: {
        info: solNetInfo,
        client: () =>
          client({
            eth_getBalance: (params?: unknown[]) => {
              evmReads.push(params?.[0]);
              return "0x1";
            },
          }),
        solanaRpc: () =>
          solRpc({
            getBalance: (params?: unknown[]) => {
              solReads.push(params?.[0]);
              return { value: 1 };
            },
            getTokenAccountsByOwner: { value: [] },
          }),
      } as never,
      chains,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: timers.setTimer,
      logger,
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await ctl.init();
    ctl.setVisible(true);
    await ctl.refresh(OWNER, "eip155:1");
    await ctl.refresh(SOL_OWNER, SOL_NET);
    await timers.fire();
    expect(evmReads).toStrictEqual([OWNER, OWNER]);
    expect(solReads).toStrictEqual([SOL_OWNER, SOL_OWNER]);
  });
});

describe("AssetsController lock", () => {
  it("a read in flight across lock() writes nothing — the next session never re-reads it", async () => {
    let balanceReads = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let readPending!: () => void;
    const pending = new Promise<void>((resolve) => {
      readPending = resolve;
    });
    const c = client({
      eth_getBalance: async () => {
        balanceReads += 1;
        readPending();
        await gate;
        return "0xde0b6b3a7640000";
      },
      eth_call: () => `0x${"0".repeat(64)}`,
    });
    const timers = manualTimers();
    const ctl = new AssetsController({
      ownBitcoinTxids: () => new Set(),
      networks: fakeNetworks(c),
      chains,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: timers.setTimer,
      logger,
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await ctl.init();

    const p = ctl.refresh(OWNER, "eip155:1");
    await pending;

    ctl.lock();
    expect(ctl.getState().balances).toStrictEqual({});

    // The read resolves and returns its balances — but writes none back into the locked state.
    releaseGate();
    const balances = await p;
    expect(balances.native).toBe("1000000000000000000");
    expect(ctl.getState().balances).toStrictEqual({});

    // The late record also dropped its reread: the next session's poll never re-reads it.
    await ctl.init();
    ctl.setVisible(true);
    await timers.fire();
    expect(balanceReads).toBe(1);
    ctl.setVisible(false);
    ctl.lock();
  });
});
