import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import type { EngineStoreError } from "../../src/errors.ts";
import { openIndexedDbEngineStore, openIndexedDbPublicStore } from "../../src/idb/indexeddb.ts";
import { contract, nulContract } from "../contract.ts";
import { corruptByte, oracleId, rawDelete, rawEntries, rawGet, rawKeys, rawPut } from "./raw.ts";

const DATA_KEY = new Uint8Array(32).fill(7);
const random = (n: number) => new Uint8Array(n).fill(3);
const utf8 = new TextEncoder();
const oId = async (collection: string, key: string): Promise<string> =>
  oracleId(DATA_KEY, collection, key);

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

  it("names records with a WebCrypto-verifiable hmac id", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([1]));
    const recId = await oId("a", "k");
    await expect(rawKeys("records")).resolves.toContain(recId);
    await expect(rawKeys("index")).resolves.toContain(recId);
    expect(recId).toMatch(/^[0-9a-f]{64}$/);
    await s.close();
  });

  it("reads a tampered ciphertext as absent", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([1, 2, 3]));
    await s.collection("a").put("other", new Uint8Array([4]));
    const recId = await oId("a", "k");
    const raw = await rawGet("records", recId);
    corruptByte(raw, 30);
    await rawPut("records", recId, raw);
    await expect(s.collection("a").get("k")).resolves.toBeUndefined();
    await expect(s.collection("a").list()).resolves.toContain("k");
    await expect(s.collection("a").get("other")).resolves.toStrictEqual(new Uint8Array([4]));
    await s.close();
  });

  it("reads a body moved to another record id as absent", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([1]));
    await s.collection("a").put("other", new Uint8Array([9]));
    const raw = await rawGet("records", await oId("a", "k"));
    // The body sealed for (a,k) re-keyed under (a,other)'s id fails that id's AAD.
    await rawPut("records", await oId("a", "other"), raw);
    await expect(s.collection("a").get("other")).resolves.toBeUndefined();
    await expect(s.collection("a").get("k")).resolves.toStrictEqual(new Uint8Array([1]));
    await s.close();
  });

  it("does not list a key whose index header is tampered or copied", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([1]));
    await s.collection("a").put("other", new Uint8Array([9]));
    // A corrupted header fails its MAC: the key drops out of list while the intact body reads.
    const header = await rawGet("index", await oId("a", "k"));
    corruptByte(header, 30);
    await rawPut("index", await oId("a", "k"), header);
    // A header copied under another id fails that id's AAD — the copy lists nothing.
    await rawPut("index", await oId("a", "other"), header);
    await expect(s.collection("a").list()).resolves.toStrictEqual([]);
    await expect(s.collection("a").get("k")).resolves.toStrictEqual(new Uint8Array([1]));
    await s.close();
  });

  it("keeps records when reopened with the same data key", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([5]));
    await s.close();
    const s2 = await open();
    await expect(s2.collection("a").get("k")).resolves.toStrictEqual(new Uint8Array([5]));
    await expect(s2.collection("a").list()).resolves.toStrictEqual(["k"]);
    await s2.close();
  });

  it("rebuilds empty when reopened with a different data key", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([5]));
    await s.close();
    const s2 = await open(new Uint8Array(32).fill(9));
    await expect(s2.collection("a").get("k")).resolves.toBeUndefined();
    await expect(s2.collection("a").list()).resolves.toStrictEqual([]);
    await expect(rawKeys("records")).resolves.toStrictEqual([]);
    await expect(rawKeys("index")).resolves.toStrictEqual(["check"]);
    await s2.close();
  });

  it("rebuilds empty when the database holds records but no check row", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([5]));
    await rawDelete("index", "check");
    await s.close();
    const s2 = await open();
    await expect(s2.collection("a").get("k")).resolves.toBeUndefined();
    await expect(rawKeys("records")).resolves.toStrictEqual([]);
    await expect(rawKeys("index")).resolves.toStrictEqual(["check"]);
    await s2.close();
  });

  it("rebuilds empty when the check row is tampered", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([5]));
    const check = await rawGet("index", "check");
    corruptByte(check, 30);
    await rawPut("index", "check", check);
    await s.close();
    const s2 = await open();
    await expect(s2.collection("a").get("k")).resolves.toBeUndefined();
    await expect(rawKeys("records")).resolves.toStrictEqual([]);
    await expect(rawKeys("index")).resolves.toStrictEqual(["check"]);
    await s2.close();
  });

  it("never lists the check row", async () => {
    useFakeIdb();
    const s = await open();
    await s.collection("a").put("k", new Uint8Array([5]));
    await expect(s.collection("check").list()).resolves.toStrictEqual([]);
    await expect(s.collection("a").list()).resolves.toStrictEqual(["k"]);
    await s.close();
  });

  it("leaks no collection names, keys or values to the raw database", async () => {
    useFakeIdb();
    const s = await open();
    await s
      .collection("spark-w1-0-mainnet")
      .put("https://dapp.example#7", utf8.encode("secret-note"));
    await s.collection("sign-log").put("2024-06-01T12:00:00Z", utf8.encode("signed-sig"));
    const probe = ["spark-w1-0-mainnet", "https://dapp.example#7", "secret-note", "sign-log"];
    const decoder = new TextDecoder();
    for (const store of ["records", "index"] as const) {
      for (const { key, value } of await rawEntries(store)) {
        for (const marker of probe) {
          expect(key).not.toContain(marker);
          expect(decoder.decode(value)).not.toContain(marker);
          const markerBytes = utf8.encode(marker);
          const found = value.some((_, i) => markerBytes.every((mb, j) => value[i + j] === mb));
          expect(found, `raw bytes leaked ${marker}`).toBe(false);
        }
      }
    }
    await s.close();
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

describe("indexeddb PublicStore", () => {
  it("stores plain bytes, survives a reopen and copies on read", async () => {
    useFakeIdb();
    const first = await openIndexedDbPublicStore({ name: "public" });
    await expect(first.get("k")).resolves.toBeUndefined();
    const bytes = new Uint8Array([1, 2, 3]);
    await first.put("k", bytes);
    bytes.fill(9);
    const second = await openIndexedDbPublicStore({ name: "public" });
    await expect(second.get("k")).resolves.toStrictEqual(new Uint8Array([1, 2, 3]));
    await first.put("k", new Uint8Array([4]));
    await expect(second.get("k")).resolves.toStrictEqual(new Uint8Array([4]));
  });

  it("keeps the bytes unencrypted in the database", async () => {
    useFakeIdb();
    const store = await openIndexedDbPublicStore({ name: "t" });
    await store.put("k", new Uint8Array([1, 2, 3]));
    await expect(rawGet("records", "k")).resolves.toStrictEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects a key containing NUL", async () => {
    useFakeIdb();
    const store = await openIndexedDbPublicStore({ name: "public" });
    await expect(store.get("a\u0000b")).rejects.toThrow("NUL");
  });
});
