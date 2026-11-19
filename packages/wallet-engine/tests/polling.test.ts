/**
 * Transaction and asset polling run on the injected `SetTimer`, which has one-shot `setTimeout`
 * semantics — the engine's own default is used here byte for byte, driven by vitest fake timers
 * (bitcoin by `manualTimers`, equivalent semantics by hand). A tx must be polled until a terminal
 * state and balances once per poll interval, with no run overlapping the next.
 */
import { decodeFunctionData, encodeFunctionResult, keccak256 } from "viem";
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { AssetsController } from "../src/assets/controller.ts";
import { MULTICALL3_ABI } from "../src/assets/evm.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { fakeSignedEvm, idleNetworkDeps, send, simulateV1Result } from "./send-helpers.ts";
import { hashOf, stateOf, world as btcWorld } from "./support/btc-world.ts";

/** Byte-for-byte the engine's `defaultSetTimer`: every call runs `fn` at most once. */
const defaultSetTimer = (ms: number, fn: () => unknown): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const POLL_MS = 4000;
const GATEWAY = "https://gateway.test";
const HOST = "http://host.local";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const SEND = {
  account: ACCOUNT,
  network: "eip155:1",
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal" as const,
  verify: { kind: "password" as const, password: "pw" },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const ZERO_WORD: Hex = `0x${"00".repeat(32)}`;

/** A node with no token balances: a zero word per call, also inside a Multicall3 batch. */
const answerCall = (params: unknown): Hex => {
  const [call] = Array.isArray(params) ? (params as [{ data?: Hex }]) : [{}];
  try {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: call.data ?? "0x" });
    return encodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      result: args[0].map(() => ({ success: true, returnData: ZERO_WORD })),
    });
  } catch {
    return ZERO_WORD;
  }
};

const evmWorld = () => {
  const counts = { getReceipt: 0, getBalance: 0 };
  /** Every JSON-RPC method the wallet asked the node, in order. */
  const calls: string[] = [];
  const node = {
    known: new Set<string>(),
    receipts: new Map<string, unknown>(),
    sent: [] as string[],
    /** When set, the next receipt read waits on it — a slow node. */
    receiptGate: undefined as Promise<void> | undefined,
    /** When set, the next eth_getBalance fails once — a flaky node. */
    failBalance: false,
  };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };

  const answer = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method);
    switch (method) {
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_estimateGas":
        return "0x5208";
      case "eth_feeHistory":
        return {
          baseFeePerGas: ["0x1", "0x1"],
          reward: [
            ["0x1", "0x2", "0x3"],
            ["0x1", "0x2", "0x3"],
          ],
        };
      case "eth_blockNumber":
        return "0x2";
      case "eth_getBlockByNumber":
        return { number: "0x2" };
      case "eth_call":
        return answerCall(params);
      case "eth_simulateV1":
        return simulateV1Result(params);
      case "eth_getBalance":
        counts.getBalance += 1;
        if (node.failBalance) {
          node.failBalance = false;
          throw new Error("upstream down");
        }
        return "0x0";
      case "eth_sendRawTransaction": {
        const raw = String(params[0]);
        node.sent.push(raw);
        const hash = keccak256(raw as Hex);
        node.known.add(hash);
        return hash;
      }
      case "eth_getTransactionByHash":
        return node.known.has(String(params[0])) ? { hash: params[0] } : null;
      case "eth_getTransactionReceipt": {
        counts.getReceipt += 1;
        const gate = node.receiptGate;
        if (gate !== undefined) {
          node.receiptGate = undefined;
          await gate;
        }
        return node.receipts.get(String(params[0])) ?? null;
      }
      default:
        throw new Error(`unmocked ${method}`);
    }
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Promise.resolve(Response.json({ networks: ["eip155:1"] }));
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    const reply = await (async (): Promise<
      { result: unknown } | { error: { code: number; message: string } }
    > => {
      try {
        return { result: await answer(body.method, body.params ?? []) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        return { error: { code: message.startsWith("unmocked") ? -32601 : -1, message } };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      await Promise.resolve();
      return fakeSignedEvm(request);
    },
  } as unknown as ReturnType<typeof chains>;

  const networks = () =>
    new NetworkController({
      ...idleNetworkDeps,
      fetch: fetchImpl,
      rpc: { "eip155:1": [HOST] },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: { warn: () => {} },
    });

  const persistedTx = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
    return raw === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  };

  let tag = 0;
  const transactions = () =>
    new TransactionController({
      wallet: {} as Wallet,
      networks: networks(),
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: defaultSetTimer,
      now: () => Date.now(),
      logger: { warn: () => {} },
      pollMs: POLL_MS,
      chains: apis,
    });

  return { node, counts, calls, apis, networks, transactions, persistedTx };
};

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_FROM = "11111111111111111111111111111112";
const SOL_TO = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_SIG = `5${"a".repeat(87)}`;
const SOL_ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};
const SOL_SEND = {
  account: SOL_ACCOUNT,
  network: SOL_NET,
  to: SOL_TO,
  amount: 1000n,
  fee: "normal" as const,
  verify: { kind: "password" as const, password: "pw" },
};

const solWorld = () => {
  const counts = { signatureStatuses: 0 };
  /** Signature → the `getSignatureStatuses` value slot; absent means still pending. */
  const statuses = new Map<string, unknown>();

  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "getLatestBlockhash":
        return {
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 1000,
          },
        };
      case "getRecentPrioritizationFees":
        return [];
      case "getMultipleAccounts":
        return { value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) };
      case "simulateTransaction": {
        const cfg = isObject(params[1]) ? params[1] : undefined;
        const accounts = isObject(cfg?.["accounts"]) ? cfg["accounts"] : undefined;
        const watch = Array.isArray(accounts?.["addresses"]) ? accounts["addresses"] : [];
        return {
          value: {
            err: null,
            logs: [],
            unitsConsumed: 6000,
            accounts: watch.map(() => null),
          },
        };
      }
      case "getBlockHeight":
        return 1;
      case "getEpochInfo":
        return { absoluteSlot: 500, blockHeight: 1 };
      case "sendTransaction":
        return SOL_SIG;
      case "getSignatureStatuses": {
        counts.signatureStatuses += 1;
        const sigs = Array.isArray(params[0]) ? params[0] : [];
        return {
          context: { slot: 500 },
          value: sigs.map((s) => statuses.get(String(s)) ?? null),
        };
      }
      default:
        throw new Error(`unmocked ${method}`);
    }
  };

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answer(body.method, body.params ?? []) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        return { error: { code: message.startsWith("unmocked") ? -32601 : -1, message } };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: SOL_NET, address: SOL_FROM }),
    sign: async ({ request }: { request: SignRequest }) => {
      await Promise.resolve();
      if (request.kind !== "solana.transaction") {
        throw new Error("unexpected request kind");
      }
      return { kind: "solana.transaction" as const, signature: new Uint8Array(64) };
    },
  } as unknown as ReturnType<typeof chains>;

  let tag = 0;
  const transactions = () =>
    new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { [SOL_NET]: [HOST] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: defaultSetTimer,
      now: () => Date.now(),
      logger: { warn: () => {} },
      pollMs: POLL_MS,
      chains: apis,
    });

  return { counts, statuses, transactions };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("transaction polling on the one-shot timer", () => {
  it("an evm transaction is polled until its receipt confirms it, then stops", async () => {
    vi.useFakeTimers();
    const w = evmWorld();
    const ctl = w.transactions();
    await ctl.init();

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const hash = hashOf(tx);

    // The node has no receipt for the first polls.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.getReceipt).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.getReceipt).toBe(2);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");

    // The receipt lands: the next poll sees it and confirms the transaction.
    w.node.receipts.set(hash, { status: "0x1", blockNumber: "0x2" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.getReceipt).toBe(3);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");

    // Terminal state disarmed the loop: nothing asks again.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.counts.getReceipt).toBe(3);
  });

  it("a solana send is polled until getSignatureStatuses confirms it, then stops", async () => {
    vi.useFakeTimers();
    const w = solWorld();
    const ctl = w.transactions();
    await ctl.init();

    const tx = await send(ctl, SOL_SEND);
    expect(tx.state).toBe("submitted");
    const hash = hashOf(tx);

    // Pending: the status read comes back null, so the poll keeps re-arming.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.signatureStatuses).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.signatureStatuses).toBe(2);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");

    w.statuses.set(hash, { confirmationStatus: "confirmed", err: null });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.signatureStatuses).toBe(3);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.counts.signatureStatuses).toBe(3);
  });

  it("a bitcoin send is polled until /status confirms it, then stops", async () => {
    const w = btcWorld();
    w.fund(1, 50_000);
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-poll");
    expect(tx.state).toBe("submitted");
    const statusCalls = (): number => w.requests.filter((r) => r.endsWith("/status")).length;

    w.setStatus(hashOf(tx), { confirmed: false });
    await booted.polls(2);
    expect(statusCalls()).toBe(2);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");

    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100 });
    await booted.polls(1);
    expect(statusCalls()).toBe(3);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");

    await booted.polls(5);
    expect(statusCalls()).toBe(3);
  });

  it("locking the vault stops transaction polling", async () => {
    vi.useFakeTimers();
    const w = evmWorld();
    const ctl = w.transactions();
    await ctl.init();

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const polled = w.calls.length;
    expect(polled).toBeGreaterThan(0);

    ctl.lock();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.calls).toHaveLength(polled);
  });

  it("a slow status read holds the next poll instead of overlapping it", async () => {
    vi.useFakeTimers();
    const w = evmWorld();
    const ctl = w.transactions();
    await ctl.init();

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const hash = hashOf(tx);

    let release = (): void => undefined;
    w.node.receiptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first poll starts and hangs inside the node read.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.getReceipt).toBe(1);
    // Many intervals pass: still exactly one read — the next run waits for this one to settle.
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(w.counts.getReceipt).toBe(1);

    // The hung read resolves (still no receipt); the loop resumes on the next interval.
    release();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.getReceipt).toBe(2);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");

    w.node.receipts.set(hash, { status: "0x1", blockNumber: "0x2" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.getReceipt).toBe(3);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
  });

  it("a poll in flight when lock() runs neither transitions nor persists the tx", async () => {
    vi.useFakeTimers();
    const w = evmWorld();
    const ctl = w.transactions();
    await ctl.init();

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const hash = hashOf(tx);

    // The node's answer is a mined receipt — but the read hangs until released.
    w.node.receipts.set(hash, { status: "0x1", blockNumber: "0x2" });
    let release = (): void => undefined;
    w.node.receiptGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.counts.getReceipt).toBe(1); // the read is in flight

    ctl.lock();
    release();
    await vi.advanceTimersByTimeAsync(POLL_MS); // let the hung read's continuation finish

    // The receipt that landed mid-lock settles nothing — and the run did not re-arm.
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
    const saved = await w.persistedTx(tx.id);
    expect(saved?.["state"]).toBe("submitted");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.counts.getReceipt).toBe(1);
  });
});

describe("asset polling on the one-shot timer", () => {
  it("balances refresh once per interval while visible and stop on hidden or lock", async () => {
    vi.useFakeTimers();
    const w = evmWorld();
    const assets = new AssetsController({
      networks: w.networks(),
      chains: { account: async () => Promise.reject(new Error("no bitcoin account in this test")) },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: defaultSetTimer,
      logger: { warn: () => {} },
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await assets.init();
    assets.setVisible(true);

    // The explicit refresh is not a poll.
    await assets.refresh(ADDR, "eip155:1");
    expect(w.counts.getBalance).toBe(1);

    // One refresh per 60 s interval.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.counts.getBalance).toBe(11);

    // Hidden: no further refreshes.
    assets.setVisible(false);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(w.counts.getBalance).toBe(11);

    // Visible again re-arms; lock disarms for good.
    assets.setVisible(true);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(w.counts.getBalance).toBe(12);
    assets.lock();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.counts.getBalance).toBe(12);
  });

  it("a failed refresh is logged and the poll keeps refreshing", async () => {
    vi.useFakeTimers();
    const w = evmWorld();
    const warnings: string[] = [];
    const assets = new AssetsController({
      networks: w.networks(),
      chains: { account: async () => Promise.reject(new Error("no bitcoin account in this test")) },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: defaultSetTimer,
      logger: {
        warn: (msg) => {
          warnings.push(msg);
        },
      },
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await assets.init();
    assets.setVisible(true);
    await assets.refresh(ADDR, "eip155:1");
    expect(w.counts.getBalance).toBe(1);

    // The next poll's refresh throws — logged, not fatal to the loop.
    w.node.failBalance = true;
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(w.counts.getBalance).toBe(2);
    expect(warnings.filter((m) => m === "assets refresh failed")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(w.counts.getBalance).toBe(3);
  });
});
