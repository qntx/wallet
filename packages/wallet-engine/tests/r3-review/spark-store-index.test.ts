/**
 * PoC for the Spark exit-chain index bug in `src/spark/store.ts`:
 *
 * `sparkStore` keeps a separate `__all__` index record that `putExitChains` maintains by
 * read-modify-write, although `EngineCollection.list()` could enumerate the records directly.
 * A record that fails authentication reads exactly like a deleted one (`src/store/port.ts`), so
 * when the index row reads as absent, the next `putExitChains` rewrites the index containing only
 * the new chains — every earlier exit chain (Spark unilateral-exit data) becomes unreachable via
 * `exitChains()` while its record still exists in the collection. Two concurrent `putExitChains`
 * calls also race: both read the same stale index and the last write silently drops the other's
 * entries.
 *
 * Correct behaviour: enumerate the collection (or otherwise reconcile against the actual records)
 * instead of trusting a read-modify-write index row, so unilateral-exit data cannot be orphaned.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeExitChain } from "../../src/spark/exit-chain-codec.ts";
import { sparkStore } from "../../src/spark/store.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";

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

const collection = () =>
  createMemoryEngineStore({
    collections: new Map<string, Map<string, Uint8Array>>(),
  }).collection("spark-exit-chains:x");

describe("PoC: spark exit-chain __all__ index orphans records", () => {
  it("PoC: an index row that reads absent (e.g. unauthenticated) orphans every earlier chain", async () => {
    const col = collection();
    const store = sparkStore(col);
    const a = chain("leaf-a");
    const b = chain("leaf-b");
    await store.putExitChains([a]);
    // Models the index row failing authentication on the next read: it reads like a deleted row.
    await col.delete("__all__");
    await store.putExitChains([b]);

    // The index was rewritten with only B; A is unreachable through the store…
    expect((await store.exitChains()).map((c) => c.leafId)).toStrictEqual([b.leafId]);
    // …but its record still exists and is enumerable via col.list().
    expect(await col.get(a.leafId)).toBeDefined();
    expect(await col.list()).toContain(a.leafId);
  });

  it("PoC: concurrent putExitChains lose one index entry (read-modify-write race)", async () => {
    const col = collection();
    const store = sparkStore(col);
    const a = chain("leaf-a");
    const b = chain("leaf-b");
    // Both calls read the same (empty) index before either writes it; last writer wins.
    await Promise.all([store.putExitChains([a]), store.putExitChains([b])]);

    const leafIds = (await store.exitChains()).map((c) => c.leafId);
    console.log("index after concurrent puts:", leafIds);
    // Exactly one of the two index entries survived; the other chain is orphaned…
    expect(leafIds).toHaveLength(1);
    // …while both records exist in the collection.
    expect(await col.get(a.leafId)).toBeDefined();
    expect(await col.get(b.leafId)).toBeDefined();
    expect((await col.list()).filter((k) => k !== "__all__").toSorted()).toStrictEqual(
      [a.leafId, b.leafId].toSorted(),
    );
  });
});
