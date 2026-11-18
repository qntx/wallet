import { NETWORK } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { BtcFrozenStore, BtcUtxoStore, scripthash } from "../src/chains/bitcoin-scan.ts";
import type { ScanUtxo } from "../src/chains/bitcoin-scan.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import {
  ACCOUNT,
  CHANGE_ADDR,
  NET,
  RECIP,
  VERIFY,
  hashOf,
  inputTxidsOf,
  send,
  world,
} from "./support/btc-world.ts";

const ownOutput = (tx: TrackedTransaction): { vout: number; value: number } => {
  const outputs = tx.btc?.outputs ?? [];
  const vout = outputs.findIndex((o) => o.own);
  const output = vout === -1 ? undefined : outputs[vout];
  if (output === undefined) {
    throw new Error("expected an own change output");
  }
  return { vout, value: output.value };
};

const utxo = (txid: string, vout: number, value: number): ScanUtxo => ({
  txid,
  vout,
  value,
  address: "bc1qtest",
  height: 100,
});

describe("BtcUtxoStore", () => {
  it("locks the selected utxos and releases them on failed/rejected/dropped", () => {
    const store = new BtcUtxoStore();
    const a = utxo("aa", 0, 100_000);
    const b = utxo("bb", 1, 50_000);
    store.replace([a, b]);
    store.lock([a], "tx-1");
    expect(store.isLocked(a)).toBe(true);
    expect(store.isLocked(b)).toBe(false);
    store.endTx("tx-1", "failed");
    expect(store.isLocked(a)).toBe(false);
    store.lock([a], "tx-2");
    store.endTx("tx-2", "rejected");
    expect(store.isLocked(a)).toBe(false);
    store.lock([a], "tx-3");
    store.endTx("tx-3", "dropped");
    expect(store.isLocked(a)).toBe(false);
    expect(store.all()).toHaveLength(2);
  });

  it("spends locked utxos on confirmed and keeps the rest", () => {
    const store = new BtcUtxoStore();
    const a = utxo("aa", 0, 100_000);
    const b = utxo("bb", 0, 546);
    store.replace([a, b]);
    store.lock([a], "tx-1");
    store.endTx("tx-1", "confirmed");
    expect(store.all().map((u) => u.txid)).toStrictEqual(["bb"]);
    expect(store.isLocked(a)).toBe(false);
  });

  it("a rescan replace preserves locked entries", () => {
    const store = new BtcUtxoStore();
    const a = utxo("aa", 0, 100_000);
    const b = utxo("bb", 0, 546);
    store.replace([a, b]);
    store.lock([a], "tx-1");
    store.replace([utxo("cc", 0, 200_000), b]);
    const all = store.all().map((u) => `${u.txid}:${u.status}`);
    expect(all).toContain("cc:confirmed");
    expect(all).toContain("aa:locked");
    expect(all).toContain("bb:confirmed");
    expect(store.isLocked(a)).toBe(true);
  });
});

/**
 * Send selection: a scanned output is spendable only once confirmed — height 0 means it can be
 * revoked by its sender and BIP-125 rule 2 forbids new unconfirmed inputs — unless the wallet
 * itself built the transaction paying it (own unconfirmed change).
 */
describe("unconfirmed UTXO selection", () => {
  it("a foreign unconfirmed output is never selected", async () => {
    const w = world();
    // The only coin is an unconfirmed deposit from a foreign transaction.
    w.fund(1, 50_000, false);
    const first = await w.boot();
    await expect(w.send(first, 10_000n, "req-1")).rejects.toThrow(/insufficient/);
    expect(w.broadcasts).toHaveLength(0);
  });

  it("own unconfirmed change from a tracked send is selectable", async () => {
    const w = world();
    const u50 = w.fund(1, 50_000);
    const first = await w.boot();
    const txA = await w.send(first, 10_000n, "req-a");
    expect(txA.state).toBe("submitted");

    // txA's own change output lands in the mempool unconfirmed; its input is gone.
    const change = ownOutput(txA);
    const changeHash = scripthash(CHANGE_ADDR, NETWORK);
    w.utxos.set(changeHash, [
      { txid: hashOf(txA), vout: change.vout, value: change.value, confirmed: false },
    ]);
    w.markUsed(changeHash, hashOf(txA));
    w.spend(u50.txid, u50.vout);

    const txB = await w.send(first, 5000n, "req-b");
    expect(txB.state).toBe("submitted");
    expect(inputTxidsOf(txB)).toContain(hashOf(txA));
  });

  it("a replacement never adds an unconfirmed extra input", async () => {
    const w = world();
    w.fund(1, 50_000);
    w.fund(2, 30_000, false);
    const first = await w.boot();
    // Change is dust, so the rule-4 floor needs an extra input — and the only spare is the
    // foreign unconfirmed one, which BIP-125 rule 2 forbids.
    const txA = await send(first, 49_400n, "req-a");
    expect(txA.state).toBe("submitted");
    await expect(
      first.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b"),
    ).rejects.toThrow(/insufficient/);
  });
});

const KEY = (txid: string, vout: number): string => `${txid}:${String(vout)}`;

describe("BtcFrozenStore", () => {
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);

  it("persists the freeze set per account key and loads it on unlock", async () => {
    const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
    const first = new BtcFrozenStore();
    await first.unlock(createMemoryEngineStore(backing));
    await first.setFrozen("w:0:net", [KEY(a, 0), KEY(b, 1)], true);
    await first.setFrozen("w:1:net", [KEY(b, 0)], true);

    const second = new BtcFrozenStore();
    await second.unlock(createMemoryEngineStore(backing));
    expect(second.frozenOf("w:0:net").toSorted()).toStrictEqual([KEY(a, 0), KEY(b, 1)]);
    expect(second.frozenOf("w:1:net")).toStrictEqual([KEY(b, 0)]);
    expect(second.isFrozen("w:0:net", KEY(a, 0))).toBe(true);
    expect(second.isFrozen("w:1:net", KEY(a, 0))).toBe(false);

    await second.setFrozen("w:0:net", [KEY(a, 0)], false);
    expect(second.frozenOf("w:0:net")).toStrictEqual([KEY(b, 1)]);
    second.lockStore();
    expect(second.frozenOf("w:0:net")).toStrictEqual([]);
  });

  it("a malformed stored record reads as an empty set", async () => {
    const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
    await createMemoryEngineStore(backing)
      .collection("btc-frozen")
      .put("w:0:net", new TextEncoder().encode("not json at all"));
    const store = new BtcFrozenStore();
    await store.unlock(createMemoryEngineStore(backing));
    expect(store.frozenOf("w:0:net")).toStrictEqual([]);
  });

  it("refuses a malformed outpoint", async () => {
    const store = new BtcFrozenStore();
    await store.unlock(createMemoryEngineStore());
    await expect(store.setFrozen("w:0:net", ["not-an-outpoint"], true)).rejects.toMatchObject({
      code: "invalid-request",
    });
  });
});

describe("bitcoin coin control", () => {
  const account = { walletId: "w", groupIndex: 0 };

  it("a freeze persists across a restart and stays per account", async () => {
    const w = world();
    const u = w.fund(1, 50_000);
    const first = await w.boot();
    await first.ctl.setUtxosFrozen(account, NET, [KEY(u.txid, 0)], true);
    expect(first.ctl.frozenUtxos(account, NET)).toStrictEqual([KEY(u.txid, 0)]);
    // Freeze intent is account-scoped: another group of the same wallet is unaffected.
    expect(first.ctl.frozenUtxos({ walletId: "w", groupIndex: 1 }, NET)).toStrictEqual([]);

    const second = await w.boot(first.backing);
    expect(second.ctl.frozenUtxos(account, NET)).toStrictEqual([KEY(u.txid, 0)]);
    second.ctl.lock();
    expect(() => second.ctl.frozenUtxos(account, NET)).toThrow(/unlocked vault/);
    await expect(second.ctl.setUtxosFrozen(account, NET, [], true)).rejects.toThrow(
      /unlocked vault/,
    );
  });

  it("automatic selection skips a frozen coin", async () => {
    const w = world();
    const a = w.fund(1, 50_000);
    const b = w.fund(2, 45_000);
    const booted = await w.boot();
    await booted.ctl.setUtxosFrozen(account, NET, [KEY(a.txid, 0)], true);
    const tx = await send(booted, 40_000n, "req-1");
    expect(tx.btc?.inputs.map((i) => KEY(i.txid, i.vout))).toStrictEqual([KEY(b.txid, 0)]);
  });

  it("a frozen coin that is the only funding fails the send until unfrozen", async () => {
    const w = world();
    const a = w.fund(1, 50_000);
    const booted = await w.boot();
    await booted.ctl.setUtxosFrozen(account, NET, [KEY(a.txid, 0)], true);
    await expect(send(booted, 10_000n, "req-1")).rejects.toThrow(/insufficient/);
    await booted.ctl.setUtxosFrozen(account, NET, [KEY(a.txid, 0)], false);
    const tx = await send(booted, 10_000n, "req-2");
    expect(tx.state).toBe("submitted");
  });

  it("`inputs` spends exactly the named outpoints", async () => {
    const w = world();
    const a = w.fund(1, 50_000);
    w.fund(2, 30_000);
    const booted = await w.boot();
    const prepared = await booted.ctl.prepareSend(
      {
        account: ACCOUNT,
        network: NET,
        to: RECIP,
        amount: 10_000n,
        fee: "slow",
        inputs: [KEY(a.txid, 0)],
      },
      "req-1",
    );
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.btc?.inputs.map((i) => KEY(i.txid, i.vout))).toStrictEqual([KEY(a.txid, 0)]);
  });

  it("naming a protected coin opts into spending it", async () => {
    const w = world();
    const dust = w.fund(1, 10_000);
    w.fund(2, 60_000);
    const booted = await w.boot();
    const prepared = await booted.ctl.prepareSend(
      {
        account: ACCOUNT,
        network: NET,
        to: RECIP,
        amount: 8000n,
        fee: "slow",
        inputs: [KEY(dust.txid, 0)],
      },
      "req-1",
    );
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.btc?.inputs.map((i) => KEY(i.txid, i.vout))).toStrictEqual([KEY(dust.txid, 0)]);
  });

  it("naming a frozen, held, foreign-unconfirmed or unknown outpoint is refused", async () => {
    const w = world();
    const a = w.fund(1, 50_000);
    const foreign = w.fund(2, 30_000, false);
    const booted = await w.boot();
    const params = (
      inputs: ReadonlyArray<string>,
    ): Parameters<typeof booted.ctl.prepareSend>[0] => ({
      account: ACCOUNT,
      network: NET,
      to: RECIP,
      amount: 10_000n,
      fee: "slow",
      inputs,
    });

    await booted.ctl.setUtxosFrozen(account, NET, [KEY(a.txid, 0)], true);
    await expect(booted.ctl.prepareSend(params([KEY(a.txid, 0)]), "req-1")).rejects.toThrow(
      `${KEY(a.txid, 0)} is frozen`,
    );
    await booted.ctl.setUtxosFrozen(account, NET, [KEY(a.txid, 0)], false);

    // A live prepared send reserves its inputs until it ends.
    await booted.ctl.prepareSend(
      {
        account: ACCOUNT,
        network: NET,
        to: RECIP,
        amount: 40_000n,
        fee: "slow",
        inputs: [KEY(a.txid, 0)],
      },
      "req-held",
    );
    await expect(booted.ctl.prepareSend(params([KEY(a.txid, 0)]), "req-2")).rejects.toThrow(
      `${KEY(a.txid, 0)} is held by another transaction`,
    );
    await expect(booted.ctl.prepareSend(params([KEY(foreign.txid, 0)]), "req-3")).rejects.toThrow(
      `${KEY(foreign.txid, 0)} is not a spendable output of this account`,
    );
    const unknown = KEY("ab".repeat(32), 0);
    await expect(booted.ctl.prepareSend(params([unknown]), "req-4")).rejects.toThrow(
      `${unknown} is not a spendable output of this account`,
    );
  });

  it("an RBF never adds a frozen extra input", async () => {
    const w = world();
    w.fund(1, 50_000);
    const b = w.fund(2, 30_000);
    const booted = await w.boot();
    // Change is dust, so the rule-4 floor needs an extra input — and the only spare is frozen.
    const txA = await send(booted, 49_400n, "req-a");
    await booted.ctl.setUtxosFrozen(account, NET, [KEY(b.txid, 0)], true);
    await expect(
      booted.ctl.prepareReplacement({ method: "speed-up", txId: txA.id }, "req-b"),
    ).rejects.toThrow(/insufficient/);
    await booted.ctl.setUtxosFrozen(account, NET, [KEY(b.txid, 0)], false);
    const bumped = await booted.ctl.prepareReplacement(
      { method: "speed-up", txId: txA.id },
      "req-c",
    );
    const txB = await bumped.submit(VERIFY, () => undefined);
    expect(txB.btc?.inputs.map((i) => KEY(i.txid, i.vout))).toContain(KEY(b.txid, 0));
  });

  it("cpfp refuses when every own parent output is frozen", async () => {
    const w = world();
    w.fund(1, 50_000);
    const booted = await w.boot();
    const txA = await send(booted, 10_000n, "req-a");
    const change = ownOutput(txA);
    await booted.ctl.setUtxosFrozen(account, NET, [KEY(hashOf(txA), change.vout)], true);
    await expect(
      booted.ctl.prepareReplacement({ method: "cpfp", txId: txA.id, feeRate: 50 }, "req-b"),
    ).rejects.toThrow("the parent's own outputs are frozen");
  });
});
