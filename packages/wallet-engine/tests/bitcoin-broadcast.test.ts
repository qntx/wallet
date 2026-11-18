import { hex } from "@scure/base";
/**
 * A Bitcoin broadcast whose answer is lost stays `submitted`: the hex and its locally computed txid
 * are persisted and the inputs locked before anything leaves, an unknown outcome is rebroadcast
 * with backoff until the endpoint (or the independent one) knows it, and only a 4xx refusal fails
 * the send and frees its inputs. Polls run on `manualTimers`.
 */
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { EsploraError } from "../src/chains/bitcoin.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { flush, hashOf, stateOf, VERIFY, world } from "./support/btc-world.ts";

/** Mirrors src/transactions/broadcast.ts's UNKNOWN_DROP_MS — how long unseen may last. */
const UNKNOWN_DROP_MS = 1_800_000;

/** The txid of the persisted wire — computed from the bytes alone, like the node would. */
const txidOf = (tx: TrackedTransaction): string => {
  if (tx.raw === undefined) {
    throw new Error("tracked transaction has no raw");
  }
  return Transaction.fromRaw(hex.decode(tx.raw)).id;
};

const outpointsOf = (tx: TrackedTransaction): string[] =>
  (tx.btc?.inputs ?? []).map((i) => `${i.txid}:${i.vout}`);

describe("a Bitcoin broadcast with an unsettled outcome", () => {
  it("accept-then-502 keeps the send submitted with its inputs locked until confirmation", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const booted = await w.boot();

    w.setPost({ kind: "accept-then-throw", error: new EsploraError("esplora /tx: 502", true) });
    const tx = await w.send(booted, 10_000n, "req-1");
    w.setPost({ kind: "ok" });

    expect(tx.state).toBe("submitted");
    expect(hashOf(tx)).toBe(txidOf(tx));
    expect(w.broadcasts).toStrictEqual([hashOf(tx)]); // the node really holds it

    await flush();
    const saved = await w.persistedUtxos(booted.backing);
    expect(saved[`${u.txid}:0`]).toMatchObject({ status: "locked", txId: tx.id });

    // The only spendable coin is held — nothing can send until this one ends.
    await expect(w.send(booted, 10_000n, "req-2")).rejects.toThrow(/insufficient/i);

    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100 });
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");

    await flush();
    const after = await w.persistedUtxos(booted.backing);
    expect(after[`${u.txid}:0`]).not.toMatchObject({ status: "locked" });
  });

  it("a 4xx refusal fails the send and frees the inputs", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const booted = await w.boot();

    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 400", false) });
    await expect(w.send(booted, 10_000n, "req-1")).rejects.toThrow(/400/);
    w.setPost({ kind: "ok" });

    const [tx] = Object.values(booted.ctl.getState().txs);
    expect(tx?.state).toBe("failed");
    expect(tx?.hash).toBeUndefined();
    expect(tx?.raw).toBeUndefined();

    // The input was released — the next send spends it normally.
    const next = await w.send(booted, 10_000n, "req-2");
    expect(next.state).toBe("submitted");
    expect(next.btc?.inputs.map((i) => i.txid)).toContain(u.txid);
  });

  it("a transport failure is rebroadcast byte-identically once the endpoint is reachable", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();

    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 502", true) });
    const tx = await w.send(booted, 10_000n, "req-1");
    w.setPost({ kind: "ok" });

    expect(tx.state).toBe("submitted");
    expect(w.broadcasts).toHaveLength(0); // never accepted

    // Status 404: the poll rebroadcasts the exact persisted bytes.
    const postsBefore = w.posts.length;
    await booted.polls(1);
    expect(w.posts).toHaveLength(postsBefore + 1);
    expect(w.posts.at(-1)).toBe(tx.raw);
    expect(w.broadcasts).toStrictEqual([hashOf(tx)]);

    w.setStatus(hashOf(tx), { confirmed: false });
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");

    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100 });
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");
  });

  it("a transaction no endpoint knows for UNKNOWN_DROP_MS is dropped and its inputs freed", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const booted = await w.boot();

    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 502", true) });
    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");

    // Every rebroadcast is refused; the status stays a 404.
    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 400", false) });
    await booted.polls(1); // first unseen poll — starts the clock
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("dropped");

    w.setPost({ kind: "ok" });
    const next = await w.send(booted, 10_000n, "req-2");
    expect(next.state).toBe("submitted");
    expect(next.btc?.inputs.map((i) => i.txid)).toContain(u.txid);
  });

  it("a transaction the independent endpoint knows is not dropped", async () => {
    const w = world({ independent: true });
    w.fund(1, 50_000);
    const booted = await w.boot();

    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 502", true) });
    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");
    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 400", false) });

    // The primary never knows it, but the independent endpoint does.
    w.setIndependentStatus(hashOf(tx), { confirmed: false });
    await booted.polls(1);
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");
  });

  it("a refused speed-up fails and the original keeps its inputs locked", async () => {
    const w = world();
    w.fund(1, 50_000);
    w.fund(2, 30_000);
    const booted = await w.boot();

    const original = await w.send(booted, 49_400n, "req-a");
    expect(original.state).toBe("submitted");
    const prepared = await booted.ctl.prepareReplacement(
      { method: "speed-up", txId: original.id },
      "req-b",
    );
    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 400", false) });
    await expect(prepared.submit(VERIFY)).rejects.toThrow(/400/);
    w.setPost({ kind: "ok" });

    const bumped = Object.values(booted.ctl.getState().txs).find((t) => t.replaces === original.id);
    expect(bumped?.state).toBe("failed");
    expect(stateOf(booted.ctl, original)).toBe("submitted");

    // The refused replacement moved the original's inputs over on hold() — refusal puts them back.
    await flush();
    const saved = await w.persistedUtxos(booted.backing);
    for (const key of outpointsOf(original)) {
      expect(saved[key]).toMatchObject({ status: "locked", txId: original.id });
    }
  });

  it("a restart in the unknown window keeps the lock and rebroadcasts the persisted raw", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const first = await w.boot();

    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 502", true) });
    const tx = await w.send(first, 10_000n, "req-1");
    w.setPost({ kind: "ok" });
    expect(tx.state).toBe("submitted");

    const second = await w.boot(first.backing);
    const reloaded = second.ctl.getState().txs[tx.id];
    expect(reloaded?.state).toBe("submitted");
    expect(reloaded?.raw).toBe(tx.raw);

    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u.txid}:0`]).toMatchObject({ status: "locked", txId: tx.id });

    await second.polls(1);
    expect(w.posts.at(-1)).toBe(tx.raw);
    expect(w.broadcasts).toStrictEqual([hashOf(tx)]);
  });

  it("a transient status failure logs the poll and keeps tracking without rebroadcasting", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");

    // A 503 status read is transient: the poll's error is logged and the loop goes on —
    // nothing is rebroadcast, because the read failed rather than the tx being unknown.
    w.setStatus(hashOf(tx), new EsploraError(`esplora /tx/${hashOf(tx)}/status: 503`, true));
    const postsBefore = w.posts.length;
    await booted.polls(2);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");
    expect(w.posts).toHaveLength(postsBefore);
    expect(w.warnings.filter((m) => m === "tx status poll failed")).toHaveLength(2);

    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100 });
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("confirmed");
  });

  it("a live replacement explains the original being unknown — no rebroadcast, no drop", async () => {
    const w = world();
    w.fund(1, 50_000);
    w.fund(2, 30_000);
    const booted = await w.boot();

    const original = await w.send(booted, 49_400n, "req-a");
    expect(original.state).toBe("submitted");

    const prepared = await booted.ctl.prepareReplacement(
      { method: "speed-up", txId: original.id },
      "req-b",
    );
    const bumped = await prepared.submit(VERIFY);
    expect(bumped.state).toBe("submitted");
    expect(bumped.replaces).toBe(original.id);

    // The pool evicted the original (404), which a submitted speed-up explains: its raw is
    // neither rebroadcast nor its drop clock started, however long the gap lasts.
    w.setStatus(hashOf(bumped), { confirmed: false });
    const postsOfOriginal = (): number => w.posts.filter((p) => p === original.raw).length;
    expect(postsOfOriginal()).toBe(1); // its own broadcast only

    await booted.polls(1);
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await booted.polls(3);
    expect(stateOf(booted.ctl, original)).toBe("submitted");
    expect(stateOf(booted.ctl, bumped)).toBe("submitted");
    expect(postsOfOriginal()).toBe(1);
  });

  it("an independent endpoint answering only transiently keeps the tx submitted", async () => {
    const w = world({ independent: true });
    w.fund(1, 50_000);
    const booted = await w.boot();

    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 502", true) });
    const tx = await w.send(booted, 10_000n, "req-1");
    w.setPost({ kind: "ok" });
    expect(tx.state).toBe("submitted");

    await booted.polls(1); // the primary's 404 starts the unseen clock

    // At drop time the independent endpoint only 503s — "may know it" — so no drop.
    w.setIndependentStatus(
      hashOf(tx),
      new EsploraError(`esplora /tx/${hashOf(tx)}/status: 503`, true),
    );
    w.clock.t += UNKNOWN_DROP_MS + 1;
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");
  });
});
