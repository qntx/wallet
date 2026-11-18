import { NETWORK } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { BtcUtxoStore, scripthash } from "../src/chains/bitcoin-scan.ts";
import type { ScanUtxo } from "../src/chains/bitcoin-scan.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { CHANGE_ADDR, hashOf, inputTxidsOf, send, world } from "./support/btc-world.ts";

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
