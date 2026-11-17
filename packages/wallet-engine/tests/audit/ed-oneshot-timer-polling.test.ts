/**
 * ED-PoC-6 — the engine's default setTimer is a ONE-SHOT setTimeout, so transaction polling and
 * asset polling each run exactly once.
 *
 * Src/engine.ts:218-226 `defaultSetTimer` (and packages/wallet-native/src/index.ts:30-35) is (ms,
 * fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); } — it fires `fn` once.
 * But src/transactions/controller.ts `track` (≈544-603) calls `this.options.setTimer(poll, fn)`
 * once and never re-arms: it relies on the timer repeating. src/assets/controller.ts `armPoll`
 * (≈166-179) arms one POLL_MS (60 s) timer the same way. createWalletEngine passes
 * `options.setTimer ?? defaultSetTimer` to both controllers (engine.ts ≈226, 308, 483…). Existing
 * tests inject a repeating fake timer or invoke the captured callback by hand, which masks this.
 *
 * Here the injected setTimer is byte-for-byte the engine default, driven by vitest fake timers: (a)
 * TransactionController: a submitted EVM tx gets exactly ONE receipt poll; when the receipt appears
 * 10 s later nothing ever asks again and the tx stays `submitted`. (b) AssetsController: exactly
 * ONE poll-driven refresh happens (at 60 s), never another.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { AssetsController } from "../../src/assets/controller.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { fakeSignedEvm, idleNetworkDeps, send } from "../send-helpers.ts";

/** Byte-for-byte the engine's defaultSetTimer (src/engine.ts:218-226). */
const defaultSetTimer = (ms: number, fn: () => unknown): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

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

const world = () => {
  const counts = { getReceipt: 0, getBalance: 0 };
  const node = {
    known: new Set<string>(),
    receipts: new Map<string, unknown>(),
    sent: [] as string[],
  };

  const answer = (method: string, params: unknown[]): unknown => {
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
      case "eth_getBalance":
        counts.getBalance += 1;
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
      case "eth_getTransactionReceipt":
        counts.getReceipt += 1;
        return node.receipts.get(String(params[0])) ?? null;
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

  const signed: SignRequest[] = [];
  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signed.push(request);
      return Promise.resolve(fakeSignedEvm(request));
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

  return { node, counts, apis, networks };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ED-PoC-6 one-shot default timer stops all polling", () => {
  it("ED-PoC-6a: an EVM tx is polled exactly once — a receipt arriving 10 s later is never seen", async () => {
    vi.useFakeTimers();
    const w = world();
    const networks = w.networks();
    let tag = 0;
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: defaultSetTimer, // ← exactly what engine.ts injects when the app does not override it
      now: () => Date.now(),
      logger: { warn: () => {} },
      pollMs: 4000,
      chains: w.apis,
    });
    await ctl.init();

    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(tx.hash).toBeTypeOf("string");

    // First (and only) poll at 4 s: the node has no receipt yet.
    await vi.advanceTimersByTimeAsync(4001);
    expect(w.counts.getReceipt).toBe(1);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");

    // The node "mines" the tx 10 s in — but no poll is ever scheduled again.
    w.node.receipts.set(tx.hash!, { status: "0x1", blockNumber: "0x2" });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.counts.getReceipt).toBe(1); // never polled again
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted"); // never confirmed
  });

  it("ED-PoC-6b: assets refresh once at 60 s and never again", async () => {
    vi.useFakeTimers();
    const w = world();
    const networks = w.networks();
    const assets = new AssetsController({
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: defaultSetTimer,
      logger: { warn: () => {} },
    });
    await assets.init();
    assets.setVisible(true); // arms the single POLL_MS timer

    // The first tracked read itself is not a poll.
    await assets.refresh(ADDR, "eip155:1");
    expect(w.counts.getBalance).toBe(1);

    // The one-shot 60 s poll fires once — and that is the last refresh ever scheduled.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(w.counts.getBalance).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(w.counts.getBalance).toBe(2); // a repeating poll would have refreshed ~10 more times
  });
});
