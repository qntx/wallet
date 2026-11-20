/**
 * `sparkStore` keeps Spark exit-chain records in one EngineCollection, each keyed by leafId and
 * enumerated through the port's `list()`. Round-trip, filtered delete and corrupt-record skipping
 * are the contract Spark relies on.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeExitChain } from "../src/spark/exit-chain-codec.ts";
import { sparkStore } from "../src/spark/store.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineCollection } from "../src/store/port.ts";

const openStore = () => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  return createMemoryEngineStore(backing);
};

const chain = (leafId: string) =>
  decodeExitChain(
    new TextEncoder().encode(
      JSON.stringify({
        leafId,
        depositAddress: "a",
        exitAddress: "b",
        signature: "c",
        amountSats: 1,
      }),
    ),
  );

const collection = () => {
  const store = openStore();
  return store.collection("spark-exit-chains");
};

/** `get(key)` throws `error` — an I/O failure on that one record. */
const throwing = (inner: EngineCollection, key: string, error: Error): EngineCollection => ({
  get: async (k) => {
    if (k === key) {
      throw error;
    }
    return inner.get(k);
  },
  put: async (k, bytes) => inner.put(k, bytes),
  delete: async (k) => inner.delete(k),
  list: async () => inner.list(),
});

describe("sparkStore", () => {
  it("returns [] on an empty collection", async () => {
    const store = sparkStore(collection());
    await expect(store.exitChains()).resolves.toStrictEqual([]);
  });

  it("round-trips chains across puts", async () => {
    const col = collection();
    const store = sparkStore(col);
    await store.putExitChains([chain("leaf-1"), chain("leaf-2")]);
    await store.putExitChains([chain("leaf-3")]);
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId).toSorted()).toStrictEqual(["leaf-1", "leaf-2", "leaf-3"]);
  });

  it("deleteExitChains removes records", async () => {
    const store = sparkStore(collection());
    await store.putExitChains([chain("leaf-1"), chain("leaf-2"), chain("leaf-3")]);
    await store.deleteExitChains(["leaf-1", "leaf-3"]);
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId)).toStrictEqual(["leaf-2"]);
  });

  it("keeps every earlier chain when a leftover index row is gone", async () => {
    const col = collection();
    const store = sparkStore(col);
    await store.putExitChains([chain("leaf-a")]);
    // A leftover `__all__` row from older data being deleted or unauthenticated must not orphan
    // the chains whose records are still in the collection.
    await col.delete("__all__");
    await store.putExitChains([chain("leaf-b")]);
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId).toSorted()).toStrictEqual(["leaf-a", "leaf-b"]);
  });

  it("keeps every chain under concurrent puts", async () => {
    const col = collection();
    const store = sparkStore(col);
    await Promise.all([
      store.putExitChains([chain("leaf-a")]),
      store.putExitChains([chain("leaf-b")]),
    ]);
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId).toSorted()).toStrictEqual(["leaf-a", "leaf-b"]);
  });

  it("skips a leftover __all__ index record", async () => {
    const col = collection();
    await col.put("__all__", new TextEncoder().encode(JSON.stringify(["leaf-1"])));
    const store = sparkStore(col);
    await expect(store.exitChains()).resolves.toStrictEqual([]);
    await store.putExitChains([chain("leaf-1")]);
    await expect(store.exitChains()).resolves.toHaveLength(1);
  });

  it("skips one corrupt chain record among good ones", async () => {
    const col = collection();
    const store = sparkStore(col);
    await store.putExitChains([chain("leaf-1")]);
    await col.put("leaf-2", new Uint8Array([0xff, 0xfe, 0x00]));
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId)).toStrictEqual(["leaf-1"]);
  });

  it("propagates a listing error", async () => {
    const col: EngineCollection = {
      ...collection(),
      list: async () => Promise.reject(new Error("io failure")),
    };
    await expect(sparkStore(col).exitChains()).rejects.toThrow("io failure");
  });

  it("propagates a record read error", async () => {
    const col = collection();
    await sparkStore(col).putExitChains([chain("leaf-1")]);
    const store = sparkStore(throwing(col, "leaf-1", new Error("io failure")));
    await expect(store.exitChains()).rejects.toThrow("io failure");
  });
});
