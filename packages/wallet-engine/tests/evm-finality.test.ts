/**
 * Inclusion is not finality. An EVM transaction keeps the receipt's block while the network can
 * still unwind it — polled at the finality interval — drops back to `submitted` when the block
 * leaves the chain (its persisted raw rebroadcast, its nonce re-held), and only stops being polled
 * once the block reaches the endpoint's `finalized` tag. A replaced sibling revives the same way.
 * Polls run on `manualTimers`.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import {
  fakeSignedEvm,
  idleNetworkDeps,
  replaceVia,
  send,
  simulateV1Result,
} from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";
import type { ManualTimers } from "./support/timers.ts";

const POLL_MS = 4000;
const FINALITY_MS = 15 * POLL_MS;
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
const VERIFY = { kind: "password" as const, password: "pw" };

const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;
const HASH_C = `0x${"cc".repeat(32)}`;

const hex = (n: number): string => `0x${n.toString(16)}`;

const receipt = (height: number, hash: string, failed = false): Record<string, string> => ({
  status: failed ? "0x0" : "0x1",
  blockNumber: hex(height),
  blockHash: hash,
});

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
  /** Every JSON-RPC method the wallet asked the node, in order. */
  const calls: string[] = [];
  const node = {
    /** Txs eth_getTransactionByHash knows — mined or pooled. */
    known: new Set<string>(),
    receipts: new Map<string, unknown>(),
    /** Height → the block hash eth_getBlockByNumber(<height>) serves; absent → null. */
    blockHashes: new Map<number, string>(),
    /** What the `finalized` tag resolves to. */
    finalized: 0,
    /** When set, the `finalized` tag read fails like an endpoint that dropped it. */
    finalizedFail: false,
    /** Eth_getTransactionCount at `latest` / `pending`. */
    latest: 0,
    pending: 0,
    sent: [] as string[],
    /** When set, the next receipt read waits on it — a slow node. */
    receiptGate: undefined as Promise<void> | undefined,
  };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };

  const answer = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method);
    switch (method) {
      case "eth_getTransactionCount":
        return hex(String(params[1]) === "pending" ? node.pending : node.latest);
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
      case "eth_getBlockByNumber": {
        const [tag] = params;
        if (tag === "finalized") {
          if (node.finalizedFail) {
            throw new Error("finalized tag unavailable");
          }
          return { number: hex(node.finalized), hash: HASH_B };
        }
        const height = Number(BigInt(String(tag)));
        const hash = node.blockHashes.get(height);
        return hash === undefined ? null : { number: hex(height), hash };
      }
      case "eth_call":
        return `0x${"00".repeat(32)}`;
      case "eth_simulateV1":
        return simulateV1Result(params);
      case "eth_getBalance":
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

  const fetchImpl: typeof fetch = async (_input, init) => {
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

  let tag = 0;
  const transactions = (timers: ManualTimers) =>
    new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { "eip155:1": [HOST] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1000,
      logger: { warn: () => {} },
      pollMs: POLL_MS,
      chains: apis,
    });

  const boot = async (): Promise<{ ctl: TransactionController; timers: ManualTimers }> => {
    const timers = manualTimers();
    const ctl = transactions(timers);
    await ctl.init();
    return { ctl, timers };
  };

  const receiptReads = (): number => calls.filter((c) => c === "eth_getTransactionReceipt").length;

  const persistedTx = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
    return raw === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  };

  return { node, calls, apis, boot, receiptReads, persistedTx, backing };
};

describe("evm inclusion, finality and reorgs", () => {
  it("a receipt keeps its block until the finalized tag passes it, then the row is never polled", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);
    expect(tx.state).toBe("submitted");

    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: HASH_A, height: 0x10 });
    expect(row?.final).toBe(false);

    // Not final: tracked again, but at the finality interval — nothing reads at pollMs.
    expect(timers.armed(FINALITY_MS)).toBe(1);
    const reads = w.receiptReads();
    await timers.fire(POLL_MS);
    expect(w.receiptReads()).toBe(reads);
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(false);

    w.node.finalized = 0x10;
    await timers.fire(FINALITY_MS);
    const done = ctl.getState().txs[tx.id];
    expect(done?.state).toBe("confirmed");
    expect(done?.final).toBe(true);
    expect(timers.armed()).toBe(0);
    const settled = w.receiptReads();
    await timers.fire();
    expect(w.receiptReads()).toBe(settled);
  });

  it("a receipt already past the finalized tag is final at once and never polled again", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    w.node.finalized = 0x10;
    await timers.fire(POLL_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: HASH_A, height: 0x10 });
    expect(row?.final).toBe(true);
    expect(timers.armed()).toBe(0);
    const reads = w.receiptReads();
    await timers.fire();
    expect(w.receiptReads()).toBe(reads);
  });

  it("a failing finalized read still records inclusion; a later read finalizes", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.node.finalizedFail = true;
    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: HASH_A, height: 0x10 });
    expect(row?.final).toBe(false);
    expect(timers.armed(FINALITY_MS)).toBe(1);

    // The recheck's own finalized read failing fails the poll — the row is untouched.
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(false);
    expect(timers.armed(FINALITY_MS)).toBe(1);

    w.node.finalizedFail = false;
    w.node.finalized = 0x10;
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(timers.armed()).toBe(0);
  });

  it("a lagging endpoint proves nothing: same hash or no block at the height is not a reorg", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");

    // The receipt answer lags but the block at the height still carries our hash.
    w.node.receipts.delete(hash);
    await timers.fire(FINALITY_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block?.height).toBe(0x10);

    // An endpoint behind the recorded height serves no block there either.
    w.node.blockHashes.delete(0x10);
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");

    // A different hash at the height is the reorg.
    w.node.blockHashes.set(0x10, HASH_C);
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("submitted");
  });

  it("a failed receipt follows the same inclusion path: reorgs, re-includes and finalizes", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.node.receipts.set(hash, receipt(0x20, HASH_B, true));
    w.node.blockHashes.set(0x20, HASH_B);
    await timers.fire(POLL_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("failed");
    expect(row?.block).toStrictEqual({ hash: HASH_B, height: 0x20 });
    expect(row?.final).toBe(false);
    expect(timers.armed(FINALITY_MS)).toBe(1);

    // A reverted inclusion sits in a block like a confirmed one — the reorg unwinds it too.
    w.node.receipts.delete(hash);
    w.node.blockHashes.set(0x20, HASH_C);
    await timers.fire(FINALITY_MS);
    const back = ctl.getState().txs[tx.id];
    expect(back?.state).toBe("submitted");
    expect(back?.block).toBeUndefined();
    expect(back?.final).toBeUndefined();

    // Re-included, it fails on chain again — under the new block, still non-final.
    w.node.receipts.set(hash, receipt(0x21, HASH_C, true));
    w.node.blockHashes.set(0x21, HASH_C);
    await timers.fire(POLL_MS);
    const again = ctl.getState().txs[tx.id];
    expect(again?.state).toBe("failed");
    expect(again?.block).toStrictEqual({ hash: HASH_C, height: 0x21 });
    expect(again?.final).toBe(false);

    w.node.finalized = 0x21;
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(timers.armed()).toBe(0);
  });

  it("a reorg clears the block, returns to submitted and rebroadcasts the persisted raw", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);
    const raw = rawOf(tx);

    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
    const sends = w.node.sent.length;

    // The block at the recorded height no longer carries our hash and the receipt is gone.
    w.node.receipts.delete(hash);
    w.node.blockHashes.set(0x10, HASH_C);
    await timers.fire(FINALITY_MS);
    const back = ctl.getState().txs[tx.id];
    expect(back?.state).toBe("submitted");
    expect(back?.block).toBeUndefined();
    expect(back?.final).toBeUndefined();
    // Back on the normal poll interval.
    expect(timers.armed(POLL_MS)).toBe(1);

    // The node lost the tx entirely: the next poll rebroadcasts the persisted bytes.
    w.node.known.delete(hash);
    await timers.fire(POLL_MS);
    expect(w.node.sent).toHaveLength(sends + 1);
    expect(w.node.sent.at(-1)).toBe(raw);

    // Mined again in a different block: a new inclusion, still not final.
    w.node.receipts.set(hash, receipt(0x11, HASH_C));
    await timers.fire(POLL_MS);
    const again = ctl.getState().txs[tx.id];
    expect(again?.state).toBe("confirmed");
    expect(again?.block).toStrictEqual({ hash: HASH_C, height: 0x11 });
    expect(again?.final).toBe(false);

    w.node.finalized = 0x12;
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(true);
  });

  it("a receipt that moved to a new block rewrites the row instead of flagging a reorg", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.block?.height).toBe(0x10);

    // The same tx landed again under a different block: the recheck adopts the new one.
    w.node.receipts.set(hash, receipt(0x12, HASH_C));
    await timers.fire(FINALITY_MS);
    const row = ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: HASH_C, height: 0x12 });
  });

  it("a confirmed pair revives: B reorgs, A returns, A confirms and B is replaced", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const original = await send(ctl, SEND);
    const bumped = await replaceVia(ctl, original.id, "speed-up", VERIFY);
    expect(bumped.state).toBe("submitted");
    expect(bumped.nonce).toBe(original.nonce);
    const bumpedHash = hashOf(bumped);
    const originalHash = hashOf(original);

    // B mines first: confirmed non-final, A is marked replaced.
    w.node.receipts.set(bumpedHash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[bumped.id]?.state).toBe("confirmed");
    expect(ctl.getState().txs[original.id]?.state).toBe("replaced");

    // B's block unwinds: B is submitted again — and A is revived with it.
    w.node.receipts.delete(bumpedHash);
    w.node.blockHashes.set(0x10, HASH_C);
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[bumped.id]?.state).toBe("submitted");
    expect(ctl.getState().txs[original.id]?.state).toBe("submitted");

    // A's receipt appears after all: A confirms and B ends replaced.
    w.node.receipts.set(originalHash, receipt(0x10, HASH_C));
    w.node.blockHashes.set(0x10, HASH_C);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[original.id]?.state).toBe("confirmed");
    expect(ctl.getState().txs[original.id]?.block).toStrictEqual({ hash: HASH_C, height: 0x10 });
    expect(ctl.getState().txs[bumped.id]?.state).toBe("replaced");
  });

  it("a reorged transaction re-holds its nonce so a new send cannot take it", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const first = await send(ctl, SEND);
    const hash = hashOf(first);

    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[first.id]?.state).toBe("confirmed");

    // While it sits in a block its nonce is spent: the next send takes nonce+1.
    const next = await send(ctl, { ...SEND, amount: 2n });
    expect(next.nonce).toBe(first.nonce + 1);

    // The reorg re-holds it: a send now would have to be a replacement, not a fresh nonce+2 —
    // and the revived row itself retries on its own nonce.
    w.node.receipts.delete(hash);
    w.node.blockHashes.set(0x10, HASH_C);
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[first.id]?.state).toBe("submitted");
    const third = await send(ctl, { ...SEND, amount: 3n });
    expect(third.nonce).toBe(first.nonce + 2);

    // A speed-up of the reorged transaction shares its nonce — accepted, not "nonce taken".
    const sped = await replaceVia(ctl, first.id, "speed-up", VERIFY);
    expect(sped.nonce).toBe(first.nonce);
    expect(sped.replaces).toBe(first.id);
  });

  it("a persisted confirmed non-final row is polled at the finality interval after a restart; a final one never is", async () => {
    const w = world();
    const first = await w.boot();
    const pending = await send(first.ctl, SEND);
    const done = await send(first.ctl, { ...SEND, amount: 2n });
    const pendingHash = hashOf(pending);
    const doneHash = hashOf(done);

    w.node.receipts.set(pendingHash, receipt(0x10, HASH_A));
    w.node.receipts.set(doneHash, receipt(0x09, HASH_B));
    w.node.blockHashes.set(0x10, HASH_A);
    w.node.blockHashes.set(0x09, HASH_B);
    w.node.finalized = 0x09;
    await first.timers.fire();
    expect(first.ctl.getState().txs[pending.id]?.final).toBe(false);
    expect(first.ctl.getState().txs[done.id]?.final).toBe(true);

    // Restart: the persisted rows reload; only the non-final one is tracked — at 15×.
    const second = await w.boot();
    expect(second.timers.armed(FINALITY_MS)).toBe(1);
    expect(second.timers.armed(POLL_MS)).toBe(0);
    expect(second.ctl.getState().txs[pending.id]?.final).toBe(false);
    expect(second.ctl.getState().txs[done.id]?.final).toBe(true);

    const reads = w.receiptReads();
    await second.timers.fire(POLL_MS);
    expect(w.receiptReads()).toBe(reads);
    w.node.finalized = 0x10;
    await second.timers.fire(FINALITY_MS);
    expect(second.ctl.getState().txs[pending.id]?.final).toBe(true);
    // The final row was never polled again — the read belonged to the non-final one.
    expect(w.receiptReads()).toBe(reads + 1);
  });

  it("lock stops reads, a mid-flight recheck writes nothing, unlock resumes the persisted row", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    const hash = hashOf(tx);

    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    w.node.blockHashes.set(0x10, HASH_A);
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("confirmed");
    expect(ctl.getState().txs[tx.id]?.final).toBe(false);

    // A recheck in flight when the vault locks: its answer — finality reached — settles nothing.
    w.node.finalized = 0x10;
    let release = (): void => undefined;
    w.node.receiptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inflight = timers.fire(FINALITY_MS);
    await Promise.resolve();
    ctl.lock();
    release();
    await inflight;
    // The locked vault holds no rows — the mid-flight answer settles nothing.
    expect(ctl.getState().txs[tx.id]).toBeUndefined();
    const saved = await w.persistedTx(tx.id);
    expect(saved?.["final"]).toBe(false);

    // Locked: nothing reads at any interval.
    const reads = w.receiptReads();
    await timers.fire();
    expect(w.receiptReads()).toBe(reads);

    // Unlock resumes from the persisted row — still confirmed, still awaiting finality — and the
    // next recheck settles what the locked one could not.
    await ctl.init();
    expect(timers.armed(FINALITY_MS)).toBe(1);
    await timers.fire(FINALITY_MS);
    expect(ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(timers.armed()).toBe(0);
  });

  it("persisted block and final round-trip; a malformed block is dropped", async () => {
    const w = world();
    const first = await w.boot();
    const tx = await send(first.ctl, SEND);
    const hash = hashOf(tx);
    w.node.receipts.set(hash, receipt(0x10, HASH_A));
    await first.timers.fire(POLL_MS);

    const saved = await w.persistedTx(tx.id);
    expect(saved?.["block"]).toStrictEqual({ hash: HASH_A, height: 0x10 });
    expect(saved?.["final"]).toBe(false);

    const second = await w.boot();
    expect(second.ctl.getState().txs[tx.id]?.block).toStrictEqual({ hash: HASH_A, height: 0x10 });
    expect(second.ctl.getState().txs[tx.id]?.final).toBe(false);

    // A malformed block is dropped on decode — the rest of the row survives.
    const store = createMemoryEngineStore(w.backing);
    await store
      .collection("transactions")
      .put(
        "bad",
        new TextEncoder().encode(JSON.stringify({ ...saved, id: "bad", block: { height: "10" } })),
      );
    const third = await w.boot();
    const { bad } = third.ctl.getState().txs;
    expect(bad?.state).toBe("confirmed");
    expect(bad?.block).toBeUndefined();
  });
});
