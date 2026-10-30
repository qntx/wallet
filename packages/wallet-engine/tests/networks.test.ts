import { describe, expect, it } from "vite-plus/test";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const logger = { warn: () => {} };
const openStore = async () => Promise.resolve(createMemoryEngineStore());

const chainIdFetch = (hexId: string) =>
  (async () => Promise.resolve(Response.json({ result: hexId }, { status: 200 }))) as typeof fetch;

describe("NetworkController", () => {
  it("accepts a custom endpoint whose eth_chainId matches the registry", async () => {
    const n = new NetworkController({ fetch: chainIdFetch("0x1"), rpc: {}, openStore, logger });
    await n.init();
    await n.addRpc("eip155:1", "https://custom.example");
    expect(n.endpoints("eip155:1")).toStrictEqual(["https://custom.example"]);
  });

  it("rejects a custom endpoint on chain id mismatch", async () => {
    const n = new NetworkController({ fetch: chainIdFetch("0x38"), rpc: {}, openStore, logger });
    await n.init();
    await expect(n.addRpc("eip155:1", "https://wrong.example")).rejects.toThrow("chain id 56");
    expect(n.endpoints("eip155:1")).toStrictEqual([]);
  });

  it("persists and reloads custom endpoints", async () => {
    const store = createMemoryEngineStore();
    const a = new NetworkController({
      fetch: chainIdFetch("0x1"),
      rpc: {},
      openStore: async () => Promise.resolve(store),
      logger,
    });
    await a.init();
    await a.addRpc("eip155:1", "https://saved.example");
    const b = new NetworkController({
      fetch: chainIdFetch("0x1"),
      rpc: { "eip155:1": ["https://host.example"] },
      openStore: async () => Promise.resolve(store),
      logger,
    });
    await b.init();
    expect(b.endpoints("eip155:1")).toStrictEqual([
      "https://saved.example",
      "https://host.example",
    ]);
  });
});
