/**
 * Inclusion is not finality. A Solana transaction keeps the slot its status entry named while the
 * cluster can still unwind it — polled at the finality interval — drops back to `submitted` when
 * a bank at or past that slot no longer has the entry (its persisted wire rebroadcast), and only
 * stops being polled at `finalized` commitment. Polls run on `manualTimers`.
 */
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { idleNetworkDeps, send } from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";

const POLL_MS = 4000;
const FINALITY_MS = 15 * POLL_MS;
const HOST = "http://host.local";
const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAYER = "11111111111111111111111111111112";
const DEST = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LVBH = 100_000;
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};
const SEND = {
  account: ACCOUNT,
  network: NET,
  to: DEST,
  amount: 1000n,
  fee: "normal" as const,
  verify: { kind: "password" as const, password: "pw" },
};

const hashOf = (tx: TrackedTransaction): string => {
  const { hash } = tx;
  if (hash === undefined) {
    throw new Error("tracked transaction has no hash");
  }
  return hash;
};

const rawOf = (tx: TrackedTransaction): string => {
  const { raw } = tx;
  if (raw === undefined) {
    throw new Error("tracked transaction has no raw");
  }
  return raw;
};

const world = () => {
  /** Signature → the getSignatureStatuses value slot; absent answers null. */
  const statuses = new Map<string, unknown>();
  /** Every wire sendTransaction carried, in order, as base64. */
  const wires: string[] = [];
  const calls: string[] = [];
  const env = {
    blockHeight: 1,
    /** The tip's absoluteSlot; `statusSlot` is the bank the status answer came from. */
    slot: 500,
    statusSlot: 500,
    /** When set, the next getSignatureStatuses read waits on it — a slow node. */
    statusGate: undefined as Promise<void> | undefined,
  };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };

  const answer = (method: string, params: unknown[]): unknown => {
    calls.push(method);
    switch (method) {
      case "getLatestBlockhash":
        return {
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: LVBH,
          },
        };
      case "getRecentPrioritizationFees":
        return [];
      case "getMultipleAccounts":
        return { value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) };
      case "simulateTransaction":
        return { value: { err: null, logs: [], unitsConsumed: 6000 } };
      case "getBlockHeight":
        return env.blockHeight;
      case "getEpochInfo":
        return { absoluteSlot: env.slot, blockHeight: env.blockHeight };
      case "sendTransaction": {
        const wire = String(params[0]);
        wires.push(wire);
        // A node answers with the transaction's own signature — the fee payer's, at bytes 1..65.
        return base58.encode(base64.decode(wire).slice(1, 65));
      }
      case "getSignatureStatuses": {
        const sigs = Array.isArray(params[0]) ? params[0] : [];
        return {
          context: { slot: env.statusSlot },
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
    if (body.method === "getSignatureStatuses" && env.statusGate !== undefined) {
      const gate = env.statusGate;
      env.statusGate = undefined;
      await gate;
    }
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

  /** A distinct signature byte per sign call — distinct wires, distinct txids. */
  let signTag = 6;
  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: NET, address: PAYER }),
    sign: async ({ request }: { request: { kind: string } }) => {
      await Promise.resolve();
      if (request.kind !== "solana.transaction") {
        throw new Error("unexpected request kind");
      }
      signTag += 1;
      return {
        kind: "solana.transaction" as const,
        signature: new Uint8Array(64).fill(signTag),
      };
    },
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const timers = manualTimers();
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { [NET]: [HOST] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (() => {
        let tag = 0;
        return (n: number) => {
          tag += 1;
          return new Uint8Array(n).fill(tag);
        };
      })(),
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: { warn: () => {} },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  const statusReads = (): number => calls.filter((c) => c === "getSignatureStatuses").length;

  return { statuses, wires, calls, env, backing, boot, statusReads };
};

describe("solana inclusion, finality and reorgs", () => {
  it("a finalized entry at first sight is final at once and never polled again", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.statuses.set(hash, { confirmationStatus: "finalized", err: null, slot: 500 });
    await timers.fire(POLL_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ height: 500 });
    expect(row?.final).toBe(true);
    expect(timers.armed()).toBe(0);
    const reads = w.statusReads();
    await timers.fire();
    expect(w.statusReads()).toBe(reads);
  });

  it("a confirmed entry keeps its slot until finalized, then the row is never polled", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);
    expect(tx.state).toBe("submitted");

    w.statuses.set(hash, { confirmationStatus: "confirmed", err: null, slot: 500 });
    await timers.fire(POLL_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ height: 500 });
    expect(row?.final).toBe(false);
    // Not final: tracked at the finality interval — nothing reads at pollMs.
    expect(timers.armed(FINALITY_MS)).toBe(1);
    const reads = w.statusReads();
    await timers.fire(POLL_MS);
    expect(w.statusReads()).toBe(reads);

    w.statuses.set(hash, { confirmationStatus: "finalized", err: null, slot: 500 });
    await timers.fire(FINALITY_MS);
    const done = ctl.getState().txs[tx.id];
    expect(done?.state).toBe("confirmed");
    expect(done?.final).toBe(true);
    expect(timers.armed()).toBe(0);
    const settled = w.statusReads();
    await timers.fire();
    expect(w.statusReads()).toBe(settled);
  });

  it("a failed inclusion keeps its slot and follows the same finality path", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.statuses.set(hash, {
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
      slot: 700,
    });
    await timers.fire(POLL_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("failed");
    expect(row?.block).toStrictEqual({ height: 700 });
    expect(row?.final).toBe(false);
    expect(timers.armed(FINALITY_MS)).toBe(1);

    w.statuses.set(hash, {
      confirmationStatus: "finalized",
      err: { InstructionError: [0, "Custom"] },
      slot: 700,
    });
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(timers.armed()).toBe(0);
  });

  it("a vanished entry past the bank's slot is a reorg: submitted again and the wire rebroadcast", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);
    const raw = rawOf(tx);

    w.statuses.set(hash, { confirmationStatus: "confirmed", err: null, slot: 500 });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
    const sent = w.wires.length;

    // A bank behind the recorded slot cannot prove the entry is gone — not a reorg.
    w.statuses.delete(hash);
    w.env.statusSlot = 499;
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");

    // A bank at the slot no longer knowing the entry is the unwind.
    w.env.statusSlot = 500;
    await timers.fire(FINALITY_MS);
    const back = ctl.getState().txs[tx.id];
    expect(back?.state).toBe("submitted");
    expect(back?.block).toBeUndefined();
    expect(back?.final).toBeUndefined();
    expect(timers.armed(POLL_MS)).toBe(1);

    // The next poll rebroadcasts the persisted wire while the blockhash is live.
    await timers.fire(POLL_MS);
    expect(w.wires).toHaveLength(sent + 1);
    expect(w.wires.at(-1)).toBe(raw);

    // Re-inclusion in another slot: a new block record, still not final.
    w.statuses.set(hash, { confirmationStatus: "confirmed", err: null, slot: 640 });
    await timers.fire(POLL_MS);
    const again = ctl.getState().txs[tx.id];
    expect(again?.state).toBe("confirmed");
    expect(again?.block).toStrictEqual({ height: 640 });
    expect(again?.final).toBe(false);

    w.statuses.set(hash, { confirmationStatus: "finalized", err: null, slot: 640 });
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(true);
  });

  it("a persisted confirmed non-final row is polled at the finality interval after a restart", async () => {
    const w = world();
    const first = await w.boot();
    const pending = await send(first.ctl, SEND);
    const done = await send(first.ctl, { ...SEND, amount: 2n });
    const pendingHash = hashOf(pending);
    const doneHash = hashOf(done);

    w.statuses.set(pendingHash, { confirmationStatus: "confirmed", err: null, slot: 500 });
    w.statuses.set(doneHash, { confirmationStatus: "finalized", err: null, slot: 480 });
    await first.timers.fire();
    expect(first.ctl.getState().txs[pending.id]?.final).toBe(false);
    expect(first.ctl.getState().txs[done.id]?.final).toBe(true);

    // Restart: the persisted rows reload; only the non-final one is tracked — at the 15× interval.
    const second = await w.boot();
    expect(second.timers.armed(FINALITY_MS)).toBe(1);
    expect(second.timers.armed(POLL_MS)).toBe(0);
    expect(second.ctl.getState().txs[pending.id]?.block).toStrictEqual({ height: 500 });

    const reads = w.statusReads();
    await second.timers.fire(POLL_MS);
    expect(w.statusReads()).toBe(reads);

    w.statuses.set(pendingHash, { confirmationStatus: "finalized", err: null, slot: 500 });
    await second.timers.fire(FINALITY_MS);
    expect(second.ctl.getState().txs[pending.id]?.final).toBe(true);
    // The final row was never polled again — the one read belonged to the non-final one.
    expect(w.statusReads()).toBe(reads + 1);
    expect(second.timers.armed()).toBe(0);
  });

  it("lock stops reads, a mid-flight recheck writes nothing, unlock resumes", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.statuses.set(hash, { confirmationStatus: "confirmed", err: null, slot: 500 });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(false);

    // A recheck in flight when the vault locks: its answer — finality reached — settles nothing.
    w.statuses.set(hash, { confirmationStatus: "finalized", err: null, slot: 500 });
    let release = (): void => undefined;
    w.env.statusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inflight = timers.fire(FINALITY_MS);
    await Promise.resolve();
    ctl.lock();
    release();
    await inflight;
    expect(ctl.getState().txs[tx.id]?.final).toBe(false);

    const reads = w.statusReads();
    await timers.fire();
    expect(w.statusReads()).toBe(reads);

    // Unlock resumes the persisted row at the finality interval — the next recheck finalizes.
    await ctl.init();
    expect(timers.armed(FINALITY_MS)).toBe(1);
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(timers.armed()).toBe(0);
  });

  it("a processed-only entry at the recorded slot is not a reorg", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.statuses.set(hash, { confirmationStatus: "confirmed", err: null, slot: 500 });
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");

    // The cluster kept an entry at the recorded slot, only not confirmed on this bank yet.
    w.statuses.set(hash, { confirmationStatus: "processed", err: null, slot: 500 });
    w.env.statusSlot = 510;
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");

    // One naming a different slot is.
    w.statuses.set(hash, { confirmationStatus: "processed", err: null, slot: 640 });
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
  });
});
