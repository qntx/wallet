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
