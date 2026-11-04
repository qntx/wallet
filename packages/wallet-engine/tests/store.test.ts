import { describe, expect, it } from "vite-plus/test";

import type { EngineStoreError } from "../src/errors.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import { contract, nulContract } from "./contract.ts";

describe("memory EngineStore", () => {
  it("satisfies the contract", async () => {
    expect.hasAssertions();
    await contract(() => createMemoryEngineStore());
  });

  it("rejects NUL in collection names and keys", async () => {
    expect.hasAssertions();
    await nulContract(() => createMemoryEngineStore());
  });

  it("use after close throws closed", async () => {
    const s = createMemoryEngineStore();
    const col = s.collection("a");
    await s.close();
    await expect(col.get("k")).rejects.toSatisfy((e) => (e as EngineStoreError).code === "closed");
  });
});

describe("memory PublicStore", () => {
  it("stores copies and shares a backing map across instances", async () => {
    const values = new Map<string, Uint8Array>();
    const first = createMemoryPublicStore({ values });
    const bytes = new Uint8Array([1, 2, 3]);
    await first.put("k", bytes);
    bytes.fill(9);
    const second = createMemoryPublicStore({ values });
    const read = await second.get("k");
    expect(read).toStrictEqual(new Uint8Array([1, 2, 3]));
    read?.fill(7);
    await expect(second.get("k")).resolves.toStrictEqual(new Uint8Array([1, 2, 3]));
    await expect(second.get("missing")).resolves.toBeUndefined();
  });

  it("rejects a key containing NUL", async () => {
    await expect(createMemoryPublicStore().get("a\u0000b")).rejects.toThrow("NUL");
  });
});
