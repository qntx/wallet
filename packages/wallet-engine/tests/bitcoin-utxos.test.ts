import { describe, expect, it } from "vite-plus/test";

import { BtcUtxoStore } from "../src/chains/bitcoin-scan.ts";
import type { ScanUtxo } from "../src/chains/bitcoin-scan.ts";

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
    expect(store.spendable().map((u) => u.txid)).toStrictEqual(["bb"]);
    store.endTx("tx-1", "failed");
    expect(store.spendable().map((u) => u.txid)).toStrictEqual(["aa", "bb"]);
    store.lock([a], "tx-2");
    store.endTx("tx-2", "rejected");
    expect(store.spendable()).toHaveLength(2);
    store.lock([a], "tx-3");
    store.endTx("tx-3", "dropped");
    expect(store.spendable()).toHaveLength(2);
  });

  it("spends locked utxos on confirmed and keeps frozen out of spendable", () => {
    const store = new BtcUtxoStore();
    store.replace([utxo("aa", 0, 100_000), utxo("bb", 0, 546)]);
    store.lock([utxo("aa", 0, 100_000)], "tx-1");
    expect(store.frozen().map((u) => u.txid)).toStrictEqual(["bb"]);
    store.endTx("tx-1", "confirmed");
    expect(store.all()).toHaveLength(1);
    expect(store.spendable().map((u) => u.txid)).toStrictEqual([]);
  });

  it("a rescan replace preserves locked and frozen entries", () => {
    const store = new BtcUtxoStore();
    store.replace([utxo("aa", 0, 100_000), utxo("bb", 0, 546)]);
    store.lock([utxo("aa", 0, 100_000)], "tx-1");
    store.replace([utxo("cc", 0, 200_000), utxo("bb", 0, 546)]);
    const all = store.all().map((u) => `${u.txid}:${u.status}`);
    expect(all).toContain("cc:confirmed");
    expect(all).toContain("aa:locked");
    expect(store.spendable().map((u) => u.txid)).toStrictEqual(["cc"]);
  });
});
