import { expect } from "vite-plus/test";

import { EngineStoreError } from "../src/errors.ts";
import type { EngineStore } from "../src/store/port.ts";

/** The shared EngineStore contract every implementation must satisfy. */
export async function contract(store: () => Promise<EngineStore> | EngineStore): Promise<void> {
  const s = await store();
  const col = s.collection("a");
  await col.put("k1", new Uint8Array([1, 2, 3]));
  const got = await col.get("k1");
  expect([...(got ?? [])]).toStrictEqual([1, 2, 3]);
  expect(await col.get("missing")).toBeUndefined();
  await col.put("k2", new Uint8Array([9]));
  const listed = await col.list();
  expect(listed.toSorted()).toStrictEqual(["k1", "k2"]);
  await col.delete("k1");
  expect(await col.get("k1")).toBeUndefined();
  expect(await s.collection("b").list()).toStrictEqual([]);
  await s.close();
  await expect(col.list()).rejects.toSatisfy(
    (e) => e instanceof EngineStoreError && e.code === "closed",
  );
}
