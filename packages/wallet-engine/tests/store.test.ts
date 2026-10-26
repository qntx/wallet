import { describe, expect, it } from "vite-plus/test";

import type { EngineStoreError } from "../src/errors.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { contract } from "./contract.ts";

describe("memory EngineStore", () => {
  it("satisfies the contract", async () => {
    expect.hasAssertions();
    await contract(() => createMemoryEngineStore());
  });

  it("use after close throws closed", async () => {
    const s = createMemoryEngineStore();
    const col = s.collection("a");
    await s.close();
    await expect(col.get("k")).rejects.toSatisfy((e) => (e as EngineStoreError).code === "closed");
  });
});
