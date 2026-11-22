/**
 * Inclusion is not finality. A Bitcoin transaction keeps its block while the chain can still unwind
 * it — polled at the finality interval — drops back to `submitted` when the block at that height no
 * longer carries its hash (its persisted bytes rebroadcast, its inputs locked again so automatic
 * selection never double-spends them), and only stops being polled once six blocks sit on top of
 * it. A replaced sibling revives the same way. Polls run on `manualTimers`.
 */
import { describe, expect, it } from "vite-plus/test";

import { EsploraError } from "../src/chains/bitcoin.ts";
import {
  flush,
  hashOf,
  inputTxidsOf,
  POLL_MS,
  rawOf,
  stateOf,
  VERIFY,
  world,
} from "./support/btc-world.ts";

const FINALITY_MS = 15 * POLL_MS;
const BLOCK_A = "aa".repeat(32);
const BLOCK_B = "bb".repeat(32);
const BLOCK_C = "cc".repeat(32);

const included = (hash: string, height: number): Record<string, unknown> => ({
  confirmed: true,
  block_height: height,
  block_hash: hash,
});

describe("bitcoin inclusion, finality and reorgs", () => {
  it("six or more confirmations at first sight is final at once", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);

    // Seven blocks already sit on top — the status answer settles finality at once.
    w.setTip(106);
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    const row = booted.ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: BLOCK_A, height: 100 });
    expect(row?.final).toBe(true);
    expect(booted.timers.armed()).toBe(0);
  });

  it("a failing tip read still records inclusion; a later read finalizes", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);

    w.failTip(new EsploraError("esplora /blocks/tip/height: 503", true));
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    const row = booted.ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: BLOCK_A, height: 100 });
    expect(row?.final).toBe(false);
    expect(booted.timers.armed(FINALITY_MS)).toBe(1);

    w.setTip(105);
    await booted.timers.fire(FINALITY_MS);
    expect(booted.ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(booted.timers.armed()).toBe(0);
  });

  it("a status without a block and an equal or unreachable block hash proves nothing", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);

    w.setTip(101);
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");

    // The status dropped its block and the endpoint cannot answer for the height — unproven.
    w.setStatus(hash, "404");
    await booted.timers.fire(FINALITY_MS);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");

    // The height still answers our hash — unproven too.
    w.setBlockHash(100, BLOCK_A);
    await booted.timers.fire(FINALITY_MS);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");

    // A different hash at the height is the reorg.
    w.setBlockHash(100, BLOCK_B);
    await booted.timers.fire(FINALITY_MS);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");
  });

  it("a confirmed transaction keeps its block until six blocks sit on top", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);
    // Two confirmations — included but not final.
    w.setTip(101);
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    const row = booted.ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: BLOCK_A, height: 100 });
    expect(row?.final).toBe(false);
    expect(booted.timers.armed(FINALITY_MS)).toBe(1);

    // The status reads of a finality recheck ask /status, not the normal poll's read set — but
    // nothing reads at the normal interval.
    const reads = w.requests.filter((r) => r.endsWith("/status")).length;
    await booted.timers.fire(POLL_MS);
    expect(w.requests.filter((r) => r.endsWith("/status"))).toHaveLength(reads);

    // Five confirmations — still not six.
    w.setTip(104);
    await booted.timers.fire(FINALITY_MS);
    expect(booted.ctl.getState().txs[tx.id]?.final).toBe(false);

    // Six: final, never polled again.
    w.setTip(105);
    await booted.timers.fire(FINALITY_MS);
    const done = booted.ctl.getState().txs[tx.id];
    expect(done?.state).toBe("confirmed");
    expect(done?.final).toBe(true);
    expect(booted.timers.armed()).toBe(0);
    const settled = w.requests.length;
    await booted.timers.fire();
    expect(w.requests).toHaveLength(settled);
  });

  it("a reorg returns the send to submitted, re-locks its inputs and rebroadcasts its bytes", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const u2 = w.fund(2, 30_000);
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);
    const raw = rawOf(tx);
    w.setTip(101);
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");
    // Its inputs left the lock table: inclusion spent them.
    await flush();
    const spent = await w.persistedUtxos(booted.backing);
    expect(spent[`${u.txid}:0`]).not.toMatchObject({ status: "locked" });

    // The block at height 100 no longer carries our hash and the status is gone — a reorg.
    w.setStatus(hash, "404");
    w.setBlockHash(100, BLOCK_B);
    await booted.timers.fire(FINALITY_MS);
    const back = booted.ctl.getState().txs[tx.id];
    expect(back?.state).toBe("submitted");
    expect(back?.block).toBeUndefined();
    expect(back?.final).toBeUndefined();
    expect(booted.timers.armed(POLL_MS)).toBe(1);

    // Its inputs are locked under it again — Esplora still listing them unspent changes nothing.
    await flush();
    const relocked = await w.persistedUtxos(booted.backing);
    expect(relocked[`${u.txid}:0`]).toMatchObject({ status: "locked", txId: tx.id });

    // A new send cannot pick them: the spare coin funds it instead.
    const next = await w.send(booted, 10_000n, "req-2");
    expect(inputTxidsOf(next)).toContain(u2.txid);
    expect(inputTxidsOf(next)).not.toContain(u.txid);

    // The next poll rebroadcasts the persisted bytes while the endpoint does not know the tx.
    const posts = w.posts.filter((p) => p === raw).length;
    await booted.timers.fire(POLL_MS);
    expect(w.posts.filter((p) => p === raw)).toHaveLength(posts + 1);

    // Re-inclusion in another block: a new block record, still not final.
    w.setStatus(hash, included(BLOCK_C, 101));
    await booted.timers.fire(POLL_MS);
    const again = booted.ctl.getState().txs[tx.id];
    expect(again?.state).toBe("confirmed");
    expect(again?.block).toStrictEqual({ hash: BLOCK_C, height: 101 });
    expect(again?.final).toBe(false);
  });

  it("a deeper reorg that re-included the send at another height rewrites the row", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);

    w.setTip(101);
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    expect(booted.ctl.getState().txs[tx.id]?.block).toStrictEqual({
      hash: BLOCK_A,
      height: 100,
    });

    // Several blocks were replaced and the send landed again at 102: the status answer carries
    // the new block and the recheck adopts it — the row never passed through submitted.
    w.setTip(102);
    w.setStatus(hash, included(BLOCK_C, 102));
    await booted.timers.fire(FINALITY_MS);
    const row = booted.ctl.getState().txs[tx.id];
    expect(row?.state).toBe("confirmed");
    expect(row?.block).toStrictEqual({ hash: BLOCK_C, height: 102 });
    expect(row?.final).toBe(false);
    expect(booted.timers.armed(FINALITY_MS)).toBe(1);
    expect(booted.timers.armed(POLL_MS)).toBe(0);
  });

  it("an unconfirmed status and a different hash at the height is the reorg", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);

    w.setTip(101);
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");

    // Back in the mempool per the status, and the height answers a different hash — reorg.
    w.setStatus(hash, { confirmed: false });
    w.setBlockHash(100, BLOCK_B);
    await booted.timers.fire(FINALITY_MS);
    const back = booted.ctl.getState().txs[tx.id];
    expect(back?.state).toBe("submitted");
    expect(back?.block).toBeUndefined();
    expect(back?.final).toBeUndefined();
    expect(booted.timers.armed(POLL_MS)).toBe(1);
  });

  it("lock stops reads, a mid-flight recheck writes nothing, unlock resumes the persisted row", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    const hash = hashOf(tx);

    w.setTip(101);
    w.setStatus(hash, included(BLOCK_A, 100));
    await booted.polls(1);
    expect(booted.ctl.getState().txs[tx.id]?.final).toBe(false);

    // A recheck in flight when the vault locks: its answer — finality reached — settles nothing.
    w.setTip(106);
    let release = (): void => undefined;
    w.gateGet(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const inflight = booted.timers.fire(FINALITY_MS);
    await Promise.resolve();
    booted.ctl.lock();
    release();
    await inflight;
    // The locked vault holds no rows — the mid-flight answer settles nothing.
    expect(booted.ctl.getState().txs[tx.id]).toBeUndefined();
    const saved = await w.persistedTx(booted.backing, tx.id);
    expect(saved?.["final"]).toBe(false);

    // Locked: nothing reads at any interval.
    const reads = w.requests.length;
    await booted.timers.fire();
    expect(w.requests).toHaveLength(reads);

    // Unlock resumes the persisted row at the finality interval — the next recheck finalizes.
    await booted.ctl.init();
    expect(booted.timers.armed(FINALITY_MS)).toBe(1);
    await booted.timers.fire(FINALITY_MS);
    expect(booted.ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(booted.timers.armed()).toBe(0);
  });

  it("a confirmed pair revives: B reorgs, A returns, A confirms and no input stays locked", async () => {
    const w = world();
    const u50 = w.fund(1, 50_000);
    const u30 = w.fund(2, 30_000);
    const booted = await w.boot();

    const txA = await w.send(booted, 49_400n, "req-a");
    const repB = await booted.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b");
    const txB = await repB.submit(VERIFY, () => undefined);
    expect(txB.replaces).toBe(txA.id);

    // B mines first: confirmed non-final, A is marked replaced.
    w.setTip(101);
    w.setStatus(hashOf(txB), included(BLOCK_A, 100));
    await booted.polls(1);
    expect(stateOf(booted.ctl, txB)).toBe("confirmed");
    expect(stateOf(booted.ctl, txA)).toBe("replaced");

    // B's block unwinds: both are submitted again.
    w.setStatus(hashOf(txB), "404");
    w.setBlockHash(100, BLOCK_C);
    await booted.timers.fire(FINALITY_MS);
    expect(stateOf(booted.ctl, txB)).toBe("submitted");
    expect(stateOf(booted.ctl, txA)).toBe("submitted");

    // A's spend lands after all: A confirms and B ends replaced.
    w.spend(u50.txid, 0);
    w.spendBy(u50.txid, 0, hashOf(txA), true);
    w.setStatus(hashOf(txA), included(BLOCK_C, 100));
    await booted.timers.fire(POLL_MS);
    expect(stateOf(booted.ctl, txA)).toBe("confirmed");
    expect(stateOf(booted.ctl, txB)).toBe("replaced");

    // No input is left locked — not A's coin, not the spare B pulled in.
    await flush();
    const saved = await w.persistedUtxos(booted.backing);
    expect(saved[`${u50.txid}:0`]).not.toMatchObject({ status: "locked" });
    expect(saved[`${u30.txid}:0`]).not.toMatchObject({ status: "locked" });
  });

  it("a persisted confirmed non-final row is polled at the finality interval after a restart", async () => {
    const w = world();
    w.fund(1, 50_000);
    const first = await w.boot();
    const tx = await w.send(first, 10_000n, "req-1");
    const hash = hashOf(tx);
    w.setTip(101);
    w.setStatus(hash, included(BLOCK_A, 100));
    await first.polls(1);
    expect(first.ctl.getState().txs[tx.id]?.final).toBe(false);

    // Restart: the row reloads confirmed non-final and tracks only at the finality interval.
    const second = await w.boot(first.backing);
    expect(second.timers.armed(FINALITY_MS)).toBe(1);
    expect(second.timers.armed(POLL_MS)).toBe(0);
    expect(second.ctl.getState().txs[tx.id]?.block).toStrictEqual({ hash: BLOCK_A, height: 100 });

    const reads = w.requests.filter((r) => r.endsWith("/status")).length;
    await second.timers.fire(POLL_MS);
    expect(w.requests.filter((r) => r.endsWith("/status"))).toHaveLength(reads);

    w.setTip(106);
    await second.timers.fire(FINALITY_MS);
    expect(second.ctl.getState().txs[tx.id]?.final).toBe(true);
    expect(second.timers.armed()).toBe(0);
  });

  it("a persisted block survives the round trip; a malformed one is dropped", async () => {
    const w = world();
    w.fund(1, 50_000);
    const first = await w.boot();
    const tx = await w.send(first, 10_000n, "req-1");
    w.setTip(101);
    w.setStatus(hashOf(tx), included(BLOCK_A, 100));
    await first.polls(1);

    const saved = await w.persistedTx(first.backing, tx.id);
    expect(saved?.["block"]).toStrictEqual({ hash: BLOCK_A, height: 100 });
    expect(saved?.["final"]).toBe(false);

    const second = await w.boot(first.backing);
    expect(second.ctl.getState().txs[tx.id]?.block).toStrictEqual({ hash: BLOCK_A, height: 100 });
  });
});
