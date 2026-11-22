/**
 * A refused send stays refused. Bytes the node rejected for good are never broadcast by this wallet
 * again — not by a poll repost, not by a restart that recovers the pre-broadcast row, and never by
 * a session that was already locked when its asynchronous work finished.
 */
import { describe, expect, it } from "vite-plus/test";

import { EsploraError } from "../src/chains/bitcoin.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { replaceVia, send, txRowPut } from "./send-helpers.ts";
import {
  inputTxidsOf,
  persistedTx as btcPersistedTx,
  persistedUtxos,
  send as btcSend,
  world as btcWorld,
} from "./support/btc-world.ts";
import { evmWorld, EVM_SEND, EVM_VERIFY, POLL_MS } from "./support/refused-worlds.ts";

/** Polls `cond` on the real clock — `vi.waitFor` never fires under this runner. */
const until = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 500; i += 1) {
    const found = probe();
    if (found !== undefined) {
      return found;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- a fixed-interval probe stays sequential
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Probe for `until`: true once the flag's predicate holds. */
const raised = (probe: () => boolean) => (): true | undefined => (probe() ? true : undefined);

/** The single row in the map — a scenario that produced none is broken, not ambiguous. */
const the = <T>(rows: ReadonlyArray<T>, what: string): T => {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new Error(`expected exactly one ${what}, got ${String(rows.length)}`);
  }
  return row;
};

const BTC_REFUSAL = new EsploraError(
  'esplora /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}',
  false,
);

/** `txid:vout` for every input a row's bitcoin build locked. */
const outpointsOf = (tx: TrackedTransaction): string[] =>
  (tx.btc?.inputs ?? []).map((input) => `${input.txid}:${input.vout}`);

describe("a send the node refuses for good", () => {
  it("ends as a durable failed row even when the refusal lands in the locked window", async () => {
    const w = evmWorld();
    const { ctl, timers } = await w.boot();
    w.armSendGate();
    const sendA = send(ctl, EVM_SEND);
    void sendA.catch(() => undefined);
    await until(
      raised(() => w.node.attempts.length === 1),
      "the broadcast attempt",
    );
    const a = the(Object.values(ctl.getState().txs), "tracked transaction");
    expect(a.state).toBe("signed");
    ctl.lock();
    w.refuse();
    w.releaseSendGate();
    await expect(sendA).rejects.toThrow(/insufficient funds/);
    const [raw] = w.node.sent;
    // Locking drops every in-memory row; the in-flight refusal must not repopulate state — it
    // queues the failed row for the next unlock instead.
    expect(ctl.getState().txs).toStrictEqual({});
    const persisted = await w.persistedTx(a.id);
    expect(persisted).toMatchObject({ state: "signed", hash: a.hash, raw });
    await ctl.init();
    const row = ctl.getState().txs[a.id];
    expect(row).toMatchObject({ state: "failed", hash: undefined });
    expect(row?.raw).toBeUndefined();
    expect(row?.error).toMatch(/insufficient funds/);
    const landed = await w.persistedTx(a.id);
    expect(landed).toMatchObject({ state: "failed" });
    expect(landed?.["hash"]).toBeUndefined();
    expect(landed?.["raw"]).toBeUndefined();
    // Terminal: nothing polls it and the refused bytes were seen by the node exactly once.
    expect(timers.armed()).toBe(0);
    await timers.fire(POLL_MS);
    expect(w.node.sent).toStrictEqual([raw]);
  });

  it("has its failed row stored by the dedicated retry when the write fails — no sibling needed", async () => {
    const w = evmWorld();
    const { ctl, timers } = await w.boot();
    w.bomb.fail = txRowPut(['"state":"failed"']);
    w.refuse();
    await expect(send(ctl, EVM_SEND)).rejects.toThrow(/insufficient funds/);
    const a = the(Object.values(ctl.getState().txs), "tracked transaction");
    expect(a.state).toBe("failed");
    // The write failed: the store still holds the durable signed row and the flush timer waits.
    const before = await w.persistedTx(a.id);
    expect(before).toMatchObject({ state: "signed" });
    expect(before?.["hash"]).toMatch(/^0x/);
    expect(before?.["raw"]).toMatch(/^0x/);
    expect(timers.armed(POLL_MS)).toBe(1);
    w.bomb.fail = undefined;
    await timers.fire(POLL_MS);
    const landed = await w.persistedTx(a.id);
    expect(landed).toMatchObject({ state: "failed" });
    expect(landed?.["hash"]).toBeUndefined();
    expect(landed?.["raw"]).toBeUndefined();
    // Landed: the flush loop stands down, and the failed row never polls.
    expect(timers.armed()).toBe(0);
    expect(w.node.sent).toHaveLength(1);
  });

  it("recovers a signed row left behind as submitted-but-never-resent after a restart", async () => {
    const w = evmWorld();
    const { ctl } = await w.boot();
    // The process dies before the failed row lands: the store still holds `signed` — and the
    // network already refused these bytes.
    w.bomb.fail = txRowPut(['"state":"failed"']);
    w.refuse();
    await expect(send(ctl, EVM_SEND)).rejects.toThrow(/insufficient funds/);
    const [sent] = w.node.sent;
    w.bomb.fail = undefined;
    const { ctl: ctl2, timers: timers2 } = await w.boot();
    const a = the(Object.values(ctl2.getState().txs), "tracked transaction");
    expect(a.state).toBe("submitted");
    expect(a.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.rebroadcast).toBe(false);
    const persistedA = await w.persistedTx(a.id);
    expect(persistedA?.["rebroadcast"]).toBe(false);
    // The row is still watched — but its polls must never resend the refused bytes.
    expect(timers2.armed(POLL_MS)).toBe(1);
    await timers2.fire(POLL_MS);
    await timers2.fire(POLL_MS);
    expect(w.node.sent).toStrictEqual([sent]);
    // Its nonce is still held: the next send signs nonce 1, not a replacement of 0.
    const b = await send(ctl2, EVM_SEND);
    expect(b.nonce).toBe(1);
    // The remedy for a stuck watched row is a replacement — it must prepare.
    const sped = await replaceVia(ctl2, a.id, "speed-up", EVM_VERIFY);
    expect(sped.replaces).toBe(a.id);
  });
});

describe("bitcoin", () => {
  it("keeps a recovered row's inputs locked and never reposts its refused bytes", async () => {
    const w = btcWorld();
    w.fund(1, 50_000);
    w.fund(2, 45_000);
    const first = await w.boot();
    // Same death window: refused by the node, failed write bombed, restart over `signed`.
    w.bomb.fail = txRowPut(['"state":"failed"']);
    w.setPost({ kind: "throw", error: BTC_REFUSAL });
    const sendA = btcSend(first, 10_000n, "req-1");
    await expect(sendA).rejects.toThrow(/400|relay fee/);
    const a = the(Object.values(first.ctl.getState().txs), "tracked transaction");
    const [refusedRaw] = w.posts;
    w.bomb.fail = undefined;
    const second = await w.boot(first.backing);
    const r = second.ctl.getState().txs[a.id];
    expect(r).toMatchObject({ state: "submitted", rebroadcast: false });
    expect(r?.hash).toMatch(/^[0-9a-f]{64}$/);
    // The recovered row re-locks its inputs at init; they never become selectable again.
    const locked = await persistedUtxos(first.backing);
    const refusedOutpoints = outpointsOf(a);
    expect(refusedOutpoints).not.toHaveLength(0);
    for (const outpoint of refusedOutpoints) {
      expect(locked[outpoint]).toMatchObject({ status: "locked", txId: a.id });
    }
    await second.polls(3);
    expect(w.posts.filter((p) => p === refusedRaw)).toHaveLength(1);
    // A fresh send funds itself from the other utxo — never from the recovered row's inputs.
    w.setPost({ kind: "ok" });
    const refused = new Set(inputTxidsOf(a));
    const b = await btcSend(second, 20_000n, "req-2");
    expect(inputTxidsOf(b).some((txid) => refused.has(txid))).toBe(false);
    const persisted = await btcPersistedTx(first.backing, a.id);
    expect(persisted).toMatchObject({ state: "submitted", rebroadcast: false });
  });
});

describe("a session that was locked while its work was in flight", () => {
  it("never broadcasts when its signature resolves after the vault re-opened", async () => {
    const w = evmWorld();
    const { ctl } = await w.boot();
    w.armSignGate();
    const sendA = send(ctl, EVM_SEND);
    void sendA.catch(() => undefined);
    await until(
      raised(() => w.signed.length === 1),
      "the signature request",
    );
    ctl.lock();
    await ctl.init();
    w.releaseSignGate();
    // The stale signature lands in a dead session: the durable write it needs throws, so the
    // send reports the lock — and, mutating nothing, the new session stays clean.
    await expect(sendA).rejects.toThrow(/unlocked vault/);
    expect(w.node.attempts).toHaveLength(0);
    expect(w.node.sent).toHaveLength(0);
    const draft = the(Object.values(ctl.getState().txs), "tracked transaction");
    expect(draft).toMatchObject({ state: "draft", hash: undefined });
    expect(draft.raw).toBeUndefined();
    const persisted = await w.persistedTx(draft.id);
    expect(persisted).toMatchObject({ state: "draft" });
    expect(persisted?.["hash"]).toBeUndefined();
  });
});
