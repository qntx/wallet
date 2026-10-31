import { encodeFunctionData, encodeFunctionResult } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { AssetsController, MULTICALL3_ABI } from "../src/assets/controller.ts";
import { ERC20_ABI, EvmChainAdapter } from "../src/chains/evm.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

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
    args: [[{ target: TOKEN, allowFailure: true, callData }]],
  });

const fakeNetworks = (c: PublicClient, multicall3?: string) =>
  ({
    client: () => c,
    info: () => ({ chainId: 1, multicall3 }),
  }) as never;

const controller = (c: PublicClient, multicall3?: string) =>
  new AssetsController({
    networks: fakeNetworks(c, multicall3),
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger,
  });

describe("EvmChainAdapter erc20", () => {
  it("encodes transfer calldata, to=token, value=0, gas=estimate×1.1", async () => {
    const a = new EvmChainAdapter();
    const c = client({ eth_getTransactionCount: "0x0", eth_estimateGas: "0x10000" });
    const tx = await a.build(c, "eip155:1", OWNER, {
      kind: "erc20",
      token: TOKEN,
      to: "0x3333333333333333333333333333333333333333",
      value: 7n,
    });
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
            result: [{ success: true, returnData: enc(5n) as `0x${string}` }],
          }),
          [encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" })]: encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "symbol",
            result: "TST",
          }),
          [encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" })]: enc(6n),
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
    expect(s?.tokens[0]?.balance).toBe("5");
    expect(s?.tokens[0]?.symbol).toBe("TST");
    expect(s?.tokens[0]?.decimals).toBe(6);
    expect(s?.tokens[0]?.verified).toBe(false);
    // one aggregate3 for all balances + one eth_call each for symbol/decimals
    expect(calls).toBe(3);

    const c2 = client({
      eth_getBalance: "0x0",
      eth_call: ethCall({ [balOf]: enc(9n) }),
    });
    const assets2 = controller(c2);
    await assets2.init();
    await assets2.addToken("eip155:1", TOKEN);
    await assets2.refresh(OWNER, "eip155:1");
    expect(assets2.getState().balances[`eip155:1:${OWNER}`]?.tokens[0]?.balance).toBe("9");
  });

  it("persists custom tokens across init and polls only while visible", async () => {
    const store = createMemoryEngineStore();
    const c = client({
      eth_getBalance: "0x0",
      eth_call: ethCall({ [balOf]: enc(1n) }),
    });
    const timers: Array<() => unknown> = [];
    const mk = () =>
      new AssetsController({
        networks: fakeNetworks(c),
        openStore: async () => Promise.resolve(store),
        setTimer: (_ms, fn) => {
          timers.push(fn);
          return () => {};
        },
        logger,
      });
    const assets = mk();
    await assets.init();
    await assets.addToken("eip155:1", TOKEN);
    const fresh = mk();
    await fresh.init();
    fresh.setVisible(true);
    expect(timers).toHaveLength(1);
    await fresh.refresh(OWNER, "eip155:1");
    void timers[0]?.();
    await new Promise((resolve) => setTimeout(resolve));
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
const T22_MINT = "Mint2022zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
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
          tokenAmount: { amount: "7", decimals: 6 },
        },
        type: "account",
      },
      program: "spl-token-2022",
    },
  },
};

const solNetInfo = (n: string) => (n === SOL_NET ? { family: "solana" } : { family: "evm" });

const balancesOf = (ctl: AssetsController, k: string) => {
  const entry = ctl.getState().balances[k];
  if (entry === undefined) {
    throw new Error(`no balance entry for ${k}`);
  }
  return entry;
};

describe("AssetsController solana", () => {
  it("reports a Token-2022 token account in balances (mint-filtered query covers it)", async () => {
    const r = solRpc({
      getBalance: { value: 5_000_000 },
      getAccountInfo: {
        value: {
          data: { parsed: { info: { decimals: 6 } }, program: "spl-token-2022" },
        },
      },
      getTokenAccountsByOwner: () => ({ value: [T22_ACCOUNT] }),
    });
    const ctl = new AssetsController({
      networks: {
        info: solNetInfo,
        solanaRpc: () => r,
      } as never,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: () => () => {},
      logger,
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
