import { hex } from "@scure/base";
/**
 * A Bitcoin broadcast whose answer is lost stays `submitted`: the hex and its locally computed txid
 * are persisted and the inputs locked before anything leaves, an unknown outcome is rebroadcast
 * with backoff until the endpoint (or the independent one) knows it, and only a 4xx refusal fails
 * the send and frees its inputs. Polls run on `manualTimers`.
 */
import { NETWORK, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";

import { prepareDappPsbts, signDappPsbts } from "../src/chains/bitcoin-dapp.ts";
import { scriptPubKey } from "../src/chains/bitcoin-scan.ts";
import { EsploraError, estimateVsize } from "../src/chains/bitcoin.ts";
import type { PreparedBitcoinPsbt } from "../src/requests/types.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import type { SignResult, TrackedTransaction } from "../src/transactions/route.ts";
import {
  flush,
  hashOf,
  inputTxidsOf,
  stateOf,
  NET,
  OUR_ADDR,
  RECIP,
  VERIFY,
  world,
} from "./support/btc-world.ts";
import type { Booted, BtcWorld, FakeUtxo } from "./support/btc-world.ts";

const isObjectRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const mutableCopy = (v: unknown): Record<string, unknown> => {
  if (!isObjectRecord(v)) {
    throw new Error("expected an object record");
  }
  return { ...v };
};

/** A recorded input list with the first entry's `value` rewritten. */
const firstInputValued = (v: unknown, value: number): ReadonlyArray<Record<string, unknown>> => {
  const inputs = Array.isArray(v) ? v.map(mutableCopy) : [];
  const head = inputs.at(0);
  if (head === undefined) {
    throw new Error("expected a recorded input");
  }
  return [{ ...head, value }, ...inputs.slice(1)];
};

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

const btcRecord = (tx: TrackedTransaction): NonNullable<TrackedTransaction["btc"]> => {
  const { btc } = tx;
  if (btc === undefined) {
    throw new Error("tracked transaction carries no build record");
  }
  return btc;
};

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

    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100, block_hash: "aa".repeat(32) });
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

    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100, block_hash: "aa".repeat(32) });
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
    await expect(prepared.submit(VERIFY, () => undefined)).rejects.toThrow(/400/);
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

    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100, block_hash: "aa".repeat(32) });
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
    const bumped = await prepared.submit(VERIFY, () => undefined);
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

/** A foreign txid — the conflict spender the wallet did not build. */
const FOREIGN_TXID = "ef".repeat(32);

describe("a Bitcoin transaction a foreign spend has evicted", () => {
  it("an input spent by a confirmed foreign tx ends tracking as replaced and frees the lock", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");

    w.setStatus(hashOf(tx), "404");
    w.spendBy(u.txid, u.vout, FOREIGN_TXID, true);
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("replaced");

    await flush();
    const locks = await w.persistedUtxos(booted.backing);
    expect(locks[`${u.txid}:${u.vout}`]?.status).toBe("confirmed");
  });

  it("an input spent by an unconfirmed foreign tx is not rebroadcast but still drops", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");
    w.setStatus(hashOf(tx), "404");
    w.spendBy(u.txid, u.vout, FOREIGN_TXID, false);

    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");
    // The bytes conflict with a live mempool tx — rebroadcasting is pointless.
    expect(w.posts).toHaveLength(1);

    w.clock.t += UNKNOWN_DROP_MS + 1;
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("dropped");
  });

  it("an unreadable outspends answer is a missed check, not a poll failure", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const booted = await w.boot();

    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).toBe("submitted");
    w.setStatus(hashOf(tx), "404");
    w.setOutspends(u.txid, "not-an-array");

    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");
    expect(w.posts).toHaveLength(2); // the ordinary rebroadcast still ran

    w.setOutspends(u.txid, new EsploraError("esplora /tx/x/outspends: 503", true));
    await booted.polls(1);
    expect(stateOf(booted.ctl, tx)).toBe("submitted");
  });
});

describe("a Bitcoin replacement after a restart", () => {
  it("speed-up, cancel and CPFP rebuild from the persisted record", async () => {
    const w = world();
    w.fund(1, 50_000);
    w.fund(2, 30_000);
    const first = await w.boot();
    const txA = await w.send(first, 10_000n, "req-a");
    expect(txA.state).toBe("submitted");

    // A fresh controller over the same store: no in-memory build context survives.
    const second = await w.boot(first.backing);
    const speed = await second.ctl.prepareReplacement(
      { method: "speed-up", txId: txA.id },
      "req-b",
    );
    const txB = await speed.submit(VERIFY, () => undefined);
    expect(txB.state).toBe("submitted");
    expect(outpointsOf(txB)).toStrictEqual(outpointsOf(txA));
    expect(w.broadcasts).toContain(hashOf(txB));

    const third = await w.boot(first.backing);
    const cancel = await third.ctl.prepareReplacement({ method: "cancel", txId: txB.id }, "req-c");
    const txC = await cancel.submit(VERIFY, () => undefined);
    expect(txC.state).toBe("submitted");
    expect(outpointsOf(txC)).toStrictEqual(outpointsOf(txA));

    const fourth = await w.boot(first.backing);
    const child = await fourth.ctl.prepareReplacement(
      { method: "cpfp", txId: txC.id, feeRate: 50 },
      "req-d",
    );
    const txD = await child.submit(VERIFY, () => undefined);
    expect(txD.state).toBe("submitted");
    // The child spends the parent's own change output.
    expect(inputTxidsOf(txD)).toStrictEqual([hashOf(txC)]);
  });

  it("a persisted record without the build fields refuses replacement cleanly", async () => {
    const w = world();
    w.fund(1, 50_000);
    const first = await w.boot();
    const txA = await w.send(first, 10_000n, "req-a");
    expect(txA.state).toBe("submitted");

    // An older wallet persisted a build record without the rebuild fields.
    const persisted = await w.persistedTx(first.backing, txA.id);
    const stripped = mutableCopy(persisted?.["btc"]);
    delete stripped["template"];
    delete stripped["groupIndex"];
    delete stripped["tier"];
    await createMemoryEngineStore(first.backing)
      .collection("transactions")
      .put(txA.id, new TextEncoder().encode(JSON.stringify({ ...persisted, btc: stripped })));

    const second = await w.boot(first.backing);
    const loaded = second.ctl.getState().txs[txA.id];
    expect(loaded?.btc).toBeUndefined();
    await expect(
      second.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b"),
    ).rejects.toThrow(/build record/);
    await expect(
      second.ctl.prepareReplacement({ method: "cpfp", txId: txA.id, feeRate: 50 }, "req-c"),
    ).rejects.toThrow(/build record/);
  });

  it("a cancel refuses when the inputs cannot pay the cancel fee", async () => {
    const w = world();
    w.fund(1, 50_000);
    const first = await w.boot();
    const txA = await w.send(first, 10_000n, "req-a");
    expect(txA.state).toBe("submitted");

    // A recorded input worth too little to cover even the fee of sweeping it back.
    const persisted = await w.persistedTx(first.backing, txA.id);
    const record = mutableCopy(persisted?.["btc"]);
    record["inputs"] = firstInputValued(record["inputs"], 600);
    await createMemoryEngineStore(first.backing)
      .collection("transactions")
      .put(txA.id, new TextEncoder().encode(JSON.stringify({ ...persisted, btc: record })));

    const second = await w.boot(first.backing);
    await expect(
      second.ctl.prepareReplacement({ method: "cancel", txId: txA.id }, "req-b"),
    ).rejects.toThrow("the inputs cannot pay the cancel fee");
  });
});

describe("a CPFP child of a legacy parent", () => {
  it.each(["btc.bip44", "btc.bip49"] as const)(
    "builds and broadcasts a bip84 child of a %s send",
    async (template) => {
      const w = world({ template });
      w.fund(1, 200_000);
      const booted = await w.boot();
      const txA = await w.send(booted, 100_000n, "req-a");
      expect(txA.state).toBe("submitted");

      const child = await booted.ctl.prepareReplacement(
        { method: "cpfp", txId: txA.id, feeRate: 50 },
        "req-c",
      );
      const txB = await child.submit(VERIFY, () => undefined);
      expect(txB.state).toBe("submitted");
      // The parent's change sits on the group's bip84 chain — the child is a bip84
      // transaction, derived and signed under that template.
      expect(btcRecord(txB).template).toBe("btc.bip84");
      expect(inputTxidsOf(txB)).toStrictEqual([hashOf(txA)]);
    },
  );
});

describe("a Bitcoin replacement pays for its own size", () => {
  it.each([
    { template: "btc.bip44" as const, inputVbytes: 148 },
    { template: "btc.bip49" as const, inputVbytes: 91 },
  ])(
    "a $template replacement clears rule 4 on the replacement's own vsize",
    async ({ template, inputVbytes }) => {
      const w = world({ template });
      w.fund(1, 200_000);
      const first = await w.boot();
      const txA = await w.send(first, 100_000n, "req-a");
      expect(txA.state).toBe("submitted");

      const rep = await first.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b");
      const txB = await rep.submit(VERIFY, () => undefined);
      const record = btcRecord(txB);
      const vsize = estimateVsize(
        record.inputs.map(() => template),
        record.outputs.map((o) => o.address),
        NETWORK,
      );
      // One legacy input, a p2wpkh payee and the bip84 change chain.
      expect(vsize).toBe(Math.ceil(10.5 + inputVbytes + 31 + 31));
      expect(record.vsize).toBe(vsize);
      // Rule 4 is priced on the replacement's vsize — the old code added only the
      // original's, which a 68 vB/input estimate understated by the whole template gap.
      expect(record.fee).toBe(Math.max(btcRecord(txA).fee + vsize, Math.ceil(vsize * 5)));
      expect(record.fee - btcRecord(txA).fee).toBeGreaterThanOrEqual(vsize);
    },
  );

  it("an extra input raises the rule-4 floor by its own vbytes", async () => {
    const w = world();
    w.fund(1, 50_000);
    w.fund(2, 30_000);
    const first = await w.boot();
    const txA = await w.send(first, 49_000n, "req-a");
    expect(txA.state).toBe("submitted");
    expect(btcRecord(txA).inputs).toHaveLength(1);

    const rep = await first.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b");
    const txB = await rep.submit(VERIFY, () => undefined);
    const record = btcRecord(txB);
    const vsize = estimateVsize(
      record.inputs.map((): BitcoinAccountTemplate => "btc.bip84"),
      record.outputs.map((o) => o.address),
      NETWORK,
    );
    expect(record.inputs).toHaveLength(2);
    expect(vsize).toBe(Math.ceil(10.5 + 2 * 68 + 31 + 31));
    expect(record.vsize).toBe(vsize);
    // The floor recomputed with the extra input — the old code priced the original's
    // one-input size and underpaid by the extra's 68 vbytes.
    expect(record.fee).toBe(Math.max(btcRecord(txA).fee + vsize, Math.ceil(vsize * 5)));
    expect(record.fee - btcRecord(txA).fee).toBeGreaterThanOrEqual(vsize);
  });

  it("a dust-sized spare is never counted toward the replacement fee or locked", async () => {
    const w = world();
    w.fund(1, 50_000);
    const u546 = w.fund(2, 546);
    const first = await w.boot();
    const txA = await w.send(first, 49_400n, "req-a");
    expect(txA.state).toBe("submitted");

    // The 546-sat coin could cover the bump on paper but ord-postage protection keeps it
    // out of `spare` — so the bump refuses rather than charge it without spending it.
    await expect(
      first.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b"),
    ).rejects.toThrow(/insufficient/);
    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u546.txid}:${u546.vout}`]).not.toMatchObject({ status: "locked" });
  });
});

const soleTx = (ctl: TransactionController): TrackedTransaction => {
  const txs = Object.values(ctl.getState().txs);
  const [tx] = txs;
  if (tx === undefined || txs.length !== 1) {
    throw new Error(`expected exactly one tracked transaction, found ${String(txs.length)}`);
  }
  return tx;
};

/** A minimal dApp PSBT spending `utxo` to the world recipient, a 1000-sat fee. */
const dappPsbt = (utxo: FakeUtxo, script: Uint8Array): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: utxo.txid,
    index: utxo.vout,
    sequence: 0xfffffffd,
    witnessUtxo: { script, amount: BigInt(utxo.value) },
  });
  tx.addOutputAddress(RECIP, BigInt(utxo.value - 1000), NETWORK);
  return tx.toPSBT(0);
};

const prepareDapp = async (
  w: BtcWorld,
  utxo: FakeUtxo,
  frozen: ReadonlySet<string> = new Set(),
): Promise<PreparedBitcoinPsbt> => {
  const [prepared] = await prepareDappPsbts(
    w.apis,
    w.es,
    { walletId: "w", groupIndex: 0 },
    NET,
    [
      {
        psbt: dappPsbt(utxo, scriptPubKey(OUR_ADDR, NETWORK)),
        sign: [{ index: 0, sigHash: "ALL", template: "btc.bip84" }],
      },
    ],
    frozen,
  );
  if (prepared === undefined) {
    throw new Error("prepareDappPsbts returned nothing");
  }
  return prepared;
};

const broadcastVia =
  (booted: Booted) =>
  async (p: PreparedBitcoinPsbt, r: SignResult): Promise<string> =>
    booted.ctl.submitDappBitcoin(NET, "w", p, r);

/** A broadcast callback that switches the endpoint to refuse on call number `failAt`. */
const broadcastRefusingCall = (
  w: BtcWorld,
  booted: Booted,
  failAt: number,
): ((p: PreparedBitcoinPsbt, r: SignResult) => Promise<string>) => {
  let calls = 0;
  return async (p, r) => {
    calls += 1;
    if (calls === failAt) {
      w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 400 bad-txns", false) });
    }
    return booted.ctl.submitDappBitcoin(NET, "w", p, r);
  };
};

describe("a dApp-signed Bitcoin broadcast", () => {
  it("a frozen outpoint is flagged on the prepared input", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    await w.boot();
    const prepared = await prepareDapp(w, u, new Set([`${u.txid}:0`]));
    expect(prepared.inputs.map((i) => i.frozen)).toStrictEqual([true]);
    const unfrozen = await prepareDapp(w, u);
    expect(unfrozen.inputs.map((i) => i.frozen)).toStrictEqual([false]);
  });

  it("an accept-then-502 returns the local txid and tracking confirms it", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const first = await w.boot();
    const prepared = await prepareDapp(w, u);
    w.setPost({ kind: "accept-then-throw", error: new EsploraError("esplora /tx: 502", true) });
    const { txids } = await signDappPsbts(
      w.apis,
      [prepared],
      true,
      VERIFY,
      () => undefined,
      broadcastVia(first),
    );
    const tx = soleTx(first.ctl);
    expect(tx.hash).toBe(txids[0]);
    expect(tx.state).toBe("submitted");
    expect(tx.btc).toBeUndefined();
    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100, block_hash: "aa".repeat(32) });
    await first.polls();
    expect(stateOf(first.ctl, tx)).toBe("confirmed");
  });

  it("a transport failure still returns the local txid and stays submitted", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const first = await w.boot();
    const prepared = await prepareDapp(w, u);
    w.setPost({ kind: "throw", error: new Error("socket hangup") });
    const { txids } = await signDappPsbts(
      w.apis,
      [prepared],
      true,
      VERIFY,
      () => undefined,
      broadcastVia(first),
    );
    const tx = soleTx(first.ctl);
    expect(tx.hash).toBe(txids[0]);
    expect(tx.state).toBe("submitted");
    w.setPost({ kind: "ok" });
    w.setStatus(hashOf(tx), { confirmed: true, block_height: 100, block_hash: "aa".repeat(32) });
    await first.polls();
    expect(stateOf(first.ctl, tx)).toBe("confirmed");
  });

  it("a 4xx refusal fails the transaction and frees its inputs", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const first = await w.boot();
    const prepared = await prepareDapp(w, u);
    w.setPost({ kind: "throw", error: new EsploraError("esplora /tx: 400 bad-txns", false) });
    await expect(
      signDappPsbts(w.apis, [prepared], true, VERIFY, () => undefined, broadcastVia(first)),
    ).rejects.toThrow(/400|bad-txns/);
    expect(Object.values(first.ctl.getState().txs).map((t) => t.state)).toStrictEqual(["failed"]);
    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u.txid}:${u.vout}`]).not.toMatchObject({ status: "locked" });
  });

  it("a live dApp transaction's inputs cannot be selected by a wallet send", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const first = await w.boot();
    const prepared = await prepareDapp(w, u);
    await signDappPsbts(w.apis, [prepared], true, VERIFY, () => undefined, broadcastVia(first));
    await expect(w.send(first, 10_000n, "req-c")).rejects.toThrow(/insufficient/);
  });

  it("a tracked dApp transaction refuses speed-up and CPFP", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const first = await w.boot();
    const prepared = await prepareDapp(w, u);
    await signDappPsbts(w.apis, [prepared], true, VERIFY, () => undefined, broadcastVia(first));
    const tx = soleTx(first.ctl);
    await expect(
      first.ctl.prepareReplacement({ method: "speed-up", txId: tx.id }, "req-b"),
    ).rejects.toThrow(/build record/);
    await expect(
      first.ctl.prepareReplacement({ method: "cpfp", txId: tx.id, feeRate: 50 }, "req-c"),
    ).rejects.toThrow(/build record/);
  });

  it("a refused second broadcast leaves the first transaction tracked", async () => {
    const w = world();
    const u1 = w.fund(1, 50_000);
    const u2 = w.fund(2, 30_000);
    const first = await w.boot();
    const p1 = await prepareDapp(w, u1);
    const p2 = await prepareDapp(w, u2);
    const outcome = await signDappPsbts(
      w.apis,
      [p1, p2],
      true,
      VERIFY,
      () => undefined,
      broadcastRefusingCall(w, first, 2),
    );
    expect(outcome.refused?.index).toBe(1);
    expect(outcome.refused?.error).toMatch(/400|bad-txns/);
    expect(outcome.txids).toHaveLength(1);
    const states = Object.values(first.ctl.getState().txs)
      .map((t) => t.state)
      .toSorted();
    expect(states).toStrictEqual(["failed", "submitted"]);
    await flush();
    const saved = await w.persistedUtxos(first.backing);
    expect(saved[`${u1.txid}:${u1.vout}`]).toMatchObject({ status: "locked" });
    expect(saved[`${u2.txid}:${u2.vout}`]).not.toMatchObject({ status: "locked" });
  });
});
