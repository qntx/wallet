/**
 * ED-PoC-5 — `lastValidBlockHeight` is persisted but never restored, so expiry detection is lost
 * after a restart and an undropped Solana tx is tracked as `submitted` forever.
 *
 * Exercises src/transactions/controller.ts `decode` (≈162-222): it rebuilds a TrackedTransaction
 * from the persisted record but does not copy `lastValidBlockHeight` back, while pollSolana
 * (src/transactions/solana.ts ≈645-662) can only declare `dropped` when `tx.lastValidBlockHeight
 * !== undefined` and the chain height moved past it.
 *
 * Scenario: send a SOL transfer that never lands (getSignatureStatuses → [null]). (a) before
 * restart, a poll with blockHeight > lastValidBlockHeight flips it to `dropped` — the mechanism
 * works in-memory; (b) after a restart, the same tx stays `submitted` no matter how high the block
 * height goes, even though the persisted JSON still carries the original lastValidBlockHeight.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import type { SolanaRpc } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { stateOf, tick, ticks } from "./btc-fakes.ts";

const PAYER = "11111111111111111111111111111112";
const DEST = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const LVBH = 100_000;
const SIG = `sig${"a".repeat(80)}`;
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};

const world = () => {
  const rpcCalls: string[] = [];
  const env = { blockHeight: 90_000 };

  const rpc: SolanaRpc = {
    call: async (method: string, params: unknown[]) => {
      rpcCalls.push(method);
      switch (method) {
        case "getLatestBlockhash":
          return Promise.resolve({
            value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: LVBH },
          });
        case "simulateTransaction":
          return Promise.resolve({
            value: { err: null, logs: [], unitsConsumed: 5000, accounts: [null] },
          });
        case "getMultipleAccounts":
          return Promise.resolve({
            value: (params[0] as ReadonlyArray<string>).map(() => null),
          });
        case "getRecentPrioritizationFees":
          return Promise.resolve([{ prioritizationFee: 100 }]);
        case "sendTransaction":
          return Promise.resolve(SIG);
        case "getSignatureStatuses":
          // The transaction never lands.
          return Promise.resolve({ value: [null] });
        case "getBlockHeight":
          return Promise.resolve(env.blockHeight);
        default:
          return Promise.reject(new Error(`unmocked ${method}`));
      }
    },
  };

  const networks = {
    info: () => ({ family: "solana" }),
    solanaRpc: () => rpc,
    independentSolanaRpc: () => ({ kind: "not-needed" }),
  } as never;

  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: NET, address: PAYER }),
    sign: async () =>
      Promise.resolve({ kind: "solana.transaction", signature: new Uint8Array(64) }),
  } as unknown as ReturnType<typeof chains>;

  const clock = { t: 1_000_000 };
  let tag = 0;
  const boot = async () => {
    const timers: Array<() => unknown> = [];
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      // Only the poll timer (pollMs = 1) is captured — the 10 s simulation bound is ignored.
      setTimer: (ms, fn) => {
        if (ms === 1) {
          timers.push(fn);
        }
        return () => {};
      },
      now: () => clock.t,
      logger: { warn: () => {} },
      pollMs: 1,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  const send = async (booted: Awaited<ReturnType<typeof boot>>, requestId: string) => {
    const prepared = await booted.ctl.prepareSend(
      { account: ACCOUNT, network: NET, to: DEST, amount: 1_000_000n, fee: "normal" },
      requestId,
    );
    return prepared.submit({ kind: "password", password: "pw" });
  };

  const persistedTx = async (id: string) => {
    const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
    return raw === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  };

  return { boot, send, env, rpcCalls, persistedTx };
};

describe("ED-PoC-5 lastValidBlockHeight is not restored", () => {
  it("ED-PoC-5: expiry drop works in-memory but is lost after restart — the tx polls forever", async () => {
    const w = world();
    const first = await w.boot();

    // (a) Baseline: while the in-memory field is set, pollSolana drops the expired tx.
    const txA = await w.send(first, "req-a");
    expect(txA.state).toBe("submitted");
    expect(txA.lastValidBlockHeight).toBe(LVBH);
    w.env.blockHeight = LVBH + 50_000;
    await tick(first.timers, 0);
    expect(stateOf(first.ctl, txA)).toBe("dropped");

    // (b) A second tx survives to a restart. The persisted record carries the field…
    const txB = await w.send(first, "req-b");
    expect(txB.state).toBe("submitted");
    const persisted = await w.persistedTx(txB.id);
    expect(persisted?.["lastValidBlockHeight"]).toBe(LVBH);

    const second = await w.boot();
    const reloaded = second.ctl.getState().txs[txB.id];
    expect(reloaded?.state).toBe("submitted");
    // …but decode() never read it back.
    expect(reloaded?.lastValidBlockHeight).toBeUndefined();

    // Polls keep running and even re-broadcast (the wire is module-global), yet the tx can
    // never be declared dropped: the expiry check is skipped without lastValidBlockHeight.
    const before = w.rpcCalls.filter((m) => m === "sendTransaction").length;
    w.env.blockHeight += 20 * 100_000; // the chain marches far past the expiry
    await ticks(second.timers, 20);
    expect(second.ctl.getState().txs[txB.id]?.state).toBe("submitted");
    expect(w.rpcCalls.filter((m) => m === "sendTransaction").length).toBeGreaterThan(before);
  });
});
