import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import type { EngineStoreError } from "../../src/errors.ts";
import { openIndexedDbEngineStore } from "../../src/idb/indexeddb.ts";
import { contract, nulContract } from "../contract.ts";
import { corruptByte, rawGet, rawPut } from "./raw.ts";

const DATA_KEY = new Uint8Array(32).fill(7);
const random = (n: number) => new Uint8Array(n).fill(3);

function useFakeIdb(): void {
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
}

async function open(key = DATA_KEY) {
  return openIndexedDbEngineStore({ name: "t", dataKey: key, random });
}

describe("indexeddb EngineStore", () => {
  it("satisfies the contract", async () => {
    expect.hasAssertions();
    useFakeIdb();
    await contract(open);
  });

  it("rejects a tampered ciphertext", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([1, 2, 3]));
    const raw = await rawGet("a\u0000k");
    corruptByte(raw, 30);
    await rawPut("a\u0000k", raw);
    await expect(s.collection("a").get("k")).rejects.toSatisfy(
      (e) => (e as EngineStoreError).code === "integrity",
    );
    await s.close();
  });

  it("rejects a record moved to another key or collection", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([1]));
    const raw = await rawGet("a\u0000k");
    await rawPut("a\u0000other", raw);
    await rawPut("b\u0000k", raw);
    await expect(s.collection("a").get("other")).rejects.toSatisfy(
      (e) => (e as EngineStoreError).code === "integrity",
    );
    await expect(s.collection("b").get("k")).rejects.toSatisfy(
      (e) => (e as EngineStoreError).code === "integrity",
    );
    await s.close();
  });

  it("rejects with the wrong data key", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([5]));
    await s.close();
    const wrong = new Uint8Array(32).fill(9);
    const s2 = await open(wrong);
    await expect(s2.collection("a").get("k")).rejects.toSatisfy(
      (e) => (e as EngineStoreError).code === "integrity",
    );
    await s2.close();
  });

  it("rejects NUL in collection names and keys", async () => {
    expect.hasAssertions();
    useFakeIdb();
    await nulContract(open);
  });

  it("use after close throws closed", async () => {
    useFakeIdb();
    const s = await open();
    const col = s.collection("a");
    await s.close();
    await expect(col.get("k")).rejects.toSatisfy((e) => (e as EngineStoreError).code === "closed");
  });
});
