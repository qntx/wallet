/**
 * Audit QA PoC (QA-06): `sparkStore` decodes stored exit chains with an unchecked JSON cast. One
 * record that is not JSON makes `exitChains()` reject for every leaf (`@qntx/spark` calls it while
 * listing spendable leaves and for `offlineExitTransactions`), and a record of the wrong shape is
 * returned typed as `SparkExitChain`.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeExitChain } from "../src/spark/exit-chain-codec.ts";
import { sparkStore } from "../src/spark/store.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const chain = (leafId: string) =>
  decodeExitChain(
    encode({ leafId, depositAddress: "a", exitAddress: "b", signature: "c", amountSats: 1 }),
  );

describe("QA PoC: sparkStore with one malformed record", () => {
  it("one non-JSON record makes exitChains() reject for every stored leaf", async () => {
    const col = createMemoryEngineStore().collection("spark-exit-chains:qa");
    const store = sparkStore(col);
    await store.putExitChains([chain("good-1"), chain("bad"), chain("good-2")]);
    await col.put("bad", new TextEncoder().encode("{not json"));
    await expect(store.exitChains()).rejects.toThrow(SyntaxError);
  });

  it("a record of the wrong shape comes back typed as SparkExitChain", async () => {
    const col = createMemoryEngineStore().collection("spark-exit-chains:qa");
    const store = sparkStore(col);
    await store.putExitChains([chain("leaf")]);
    await col.put("leaf", encode({ leafId: 42 }));
    const [stored] = await store.exitChains();
    expect(stored?.leafId).toBeTypeOf("number");
  });
});
