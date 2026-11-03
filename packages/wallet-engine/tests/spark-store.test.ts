/**
 * `sparkStore` keeps Spark exit-chain records in one EngineCollection: each chain keyed by leafId
 * plus an index record listing them. Round-trip, index merge on put and filtered delete are the
 * contract Spark relies on.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeExitChain } from "../src/spark/exit-chain-codec.ts";
import { sparkStore } from "../src/spark/store.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

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

describe("sparkStore", () => {
  it("returns [] on an empty collection", async () => {
    const store = sparkStore(collection());
    await expect(store.exitChains()).resolves.toStrictEqual([]);
  });

  it("round-trips chains and merges the index across puts", async () => {
    const col = collection();
    const store = sparkStore(col);
    await store.putExitChains([chain("leaf-1"), chain("leaf-2")]);
    await store.putExitChains([chain("leaf-3")]);
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId).toSorted()).toStrictEqual(["leaf-1", "leaf-2", "leaf-3"]);
  });

  it("deleteExitChains removes records and prunes the index", async () => {
    const store = sparkStore(collection());
    await store.putExitChains([chain("leaf-1"), chain("leaf-2"), chain("leaf-3")]);
    await store.deleteExitChains(["leaf-1", "leaf-3"]);
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId)).toStrictEqual(["leaf-2"]);
  });

  it("treats a non-array index as empty", async () => {
    const col = collection();
    await col.put("__all__", new TextEncoder().encode(JSON.stringify({ nope: 1 })));
    const store = sparkStore(col);
    await expect(store.exitChains()).resolves.toStrictEqual([]);
    await store.putExitChains([chain("leaf-9")]);
    await expect(store.exitChains()).resolves.toHaveLength(1);
  });

  it("skips index entries whose record is gone", async () => {
    const col = collection();
    const store = sparkStore(col);
    await store.putExitChains([chain("leaf-1"), chain("leaf-2")]);
    await col.delete("leaf-1");
    const got = await store.exitChains();
    expect(got.map((c) => c.leafId)).toStrictEqual(["leaf-2"]);
  });
});
