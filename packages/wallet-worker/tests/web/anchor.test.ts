import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createCacheAnchor } from "../../src/worker/anchor.ts";

const CACHE_NAME = "qntx-wallet-anchor";

beforeEach(async () => {
  await caches.delete(CACHE_NAME);
});

const state = (fill: number): Uint8Array => new Uint8Array(21).fill(fill);

describe("Cache Storage vault anchor", () => {
  it("reads nothing before a first write, then the written bytes", async () => {
    const anchor = createCacheAnchor();
    await expect(anchor.read()).resolves.toBeUndefined();
    await expect(anchor.replace(state(7), undefined)).resolves.toBe(true);
    await expect(anchor.read()).resolves.toStrictEqual(state(7));
  });

  it("compare-and-swap writes only when the stored bytes equal the expected", async () => {
    const anchor = createCacheAnchor();
    // A non-undefined expectation against an empty anchor cannot write.
    await expect(anchor.replace(state(1), state(0))).resolves.toBe(false);
    await expect(anchor.replace(state(1), undefined)).resolves.toBe(true);
    await expect(anchor.replace(state(2), state(9))).resolves.toBe(false);
    await expect(anchor.read()).resolves.toStrictEqual(state(1));
    await expect(anchor.replace(state(2), state(1))).resolves.toBe(true);
    await expect(anchor.read()).resolves.toStrictEqual(state(2));
  });

  it("is shared between anchor instances and survives the vault database's deletion", async () => {
    const first = createCacheAnchor();
    await first.replace(state(3), undefined);
    const second = createCacheAnchor();
    await expect(second.read()).resolves.toStrictEqual(state(3));
    // The vault store's whole backend can go away without touching the anchor.
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase("qntx-wallet");
      request.addEventListener("success", resolve);
      request.addEventListener("error", resolve);
      request.addEventListener("blocked", resolve);
    });
    await expect(second.read()).resolves.toStrictEqual(state(3));
  });

  it("serializes concurrent replaces through the cross-tab lock", async () => {
    const a = createCacheAnchor();
    const b = createCacheAnchor();
    await a.replace(state(0), undefined);
    // Both expect the same stored bytes: exactly one CAS may land.
    const [first, second] = await Promise.all([
      a.replace(state(1), state(0)),
      b.replace(state(2), state(0)),
    ]);
    expect(new Set([first, second])).toStrictEqual(new Set([false, true]));
  });
});
