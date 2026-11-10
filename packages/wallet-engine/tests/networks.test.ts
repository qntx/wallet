import { base58 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { NetworkController } from "../src/networks/controller.ts";
import { BITCOIN_NETWORKS, NETWORKS, SOLANA_NETWORKS } from "../src/networks/registry.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { idleNetworkDeps } from "./send-helpers.ts";

const logger = { warn: () => {} };
const openStore = async () => Promise.resolve(createMemoryEngineStore());

const chainIdFetch = (hexId: string) =>
  (async () => Promise.resolve(Response.json({ result: hexId }, { status: 200 }))) as typeof fetch;

const [BTC] = BITCOIN_NETWORKS;
if (BTC === undefined) {
  throw new Error("the registry has no bitcoin network");
}

/** An Esplora that answers only the genesis probe. */
const esploraFetch = (async (input: string | URL | Request) => {
  await Promise.resolve();
  return String(input).endsWith("/block-height/0")
    ? new Response(BTC.genesisHash ?? "")
    : new Response("not found", { status: 404 });
}) as typeof fetch;

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const genesisFetch = (hash: string) =>
  (async () =>
    Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: hash }))) as typeof fetch;

describe("network registry", () => {
  it("marks exactly the OP Stack chains", () => {
    expect(
      NETWORKS.filter((n) => n.opStack === true)
        .map((n) => n.chainId)
        .toSorted((a, b) => a - b),
    ).toStrictEqual([10, 8453, 84532, 11155420]);
  });

  it.each([...SOLANA_NETWORKS, ...BITCOIN_NETWORKS])(
    "$id reference is the first 32 characters of its genesis hash",
    (network) => {
      expect(network.genesisHash).toBeDefined();
      expect(network.id.split(":")[1]).toBe(network.genesisHash?.slice(0, 32));
    },
  );

  it.each(SOLANA_NETWORKS)("$id genesis hash is a base58 32-byte hash", (network) => {
    expect(base58.decode(String(network.genesisHash))).toHaveLength(32);
  });

  it.each(BITCOIN_NETWORKS)("$id genesis hash is 64 lowercase hex characters", (network) => {
    expect(network.genesisHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("NetworkController", () => {
  it("accepts a Solana endpoint that reports the registry genesis hash", async () => {
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: genesisFetch(DEVNET_GENESIS),
      rpc: {},
      openStore,
      logger,
    });
    await n.init();
    await n.addRpc(DEVNET, "https://custom.example");
    expect(n.endpoints(DEVNET)).toStrictEqual(["https://custom.example"]);
  });

  it("rejects a Solana endpoint that reports another genesis hash", async () => {
    const mainnet = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: genesisFetch(mainnet),
      rpc: {},
      openStore,
      logger,
    });
    await n.init();
    await expect(n.addRpc(DEVNET, "https://wrong.example")).rejects.toThrow("genesis hash");
    expect(n.endpoints(DEVNET)).toStrictEqual([]);
  });

  it("accepts a custom endpoint whose eth_chainId matches the registry", async () => {
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: chainIdFetch("0x1"),
      rpc: {},
      openStore,
      logger,
    });
    await n.init();
    await n.addRpc("eip155:1", "https://custom.example");
    expect(n.endpoints("eip155:1")).toStrictEqual(["https://custom.example"]);
  });

  it("rejects a custom endpoint on chain id mismatch", async () => {
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: chainIdFetch("0x38"),
      rpc: {},
      openStore,
      logger,
    });
    await n.init();
    await expect(n.addRpc("eip155:1", "https://wrong.example")).rejects.toThrow("chain id 56");
    expect(n.endpoints("eip155:1")).toStrictEqual([]);
  });

  it("persists and reloads custom endpoints", async () => {
    const store = createMemoryEngineStore();
    const a = new NetworkController({
      ...idleNetworkDeps,
      fetch: chainIdFetch("0x1"),
      rpc: {},
      openStore: async () => Promise.resolve(store),
      logger,
    });
    await a.init();
    await a.addRpc("eip155:1", "https://saved.example");
    const b = new NetworkController({
      ...idleNetworkDeps,
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

  it("re-verifies persisted endpoints at unlock and skips one that changed chain", async () => {
    const store = createMemoryEngineStore();
    const a = new NetworkController({
      ...idleNetworkDeps,
      fetch: chainIdFetch("0x1"),
      rpc: {},
      openStore: async () => Promise.resolve(store),
      logger,
    });
    await a.init();
    await a.addRpc("eip155:1", "https://saved.example");
    const warnings: string[] = [];
    const b = new NetworkController({
      ...idleNetworkDeps,
      fetch: chainIdFetch("0x38"),
      rpc: { "eip155:1": ["https://host.example"] },
      openStore: async () => Promise.resolve(store),
      logger: { warn: (message: string) => warnings.push(message) },
    });
    await b.init();
    expect(b.endpoints("eip155:1")).toStrictEqual(["https://host.example"]);
    expect(warnings).toContain(
      "custom endpoint not used for this session: eip155:1 https://saved.example",
    );
    // Still persisted: the next unlock re-checks it rather than losing the user's setting.
    const c = new NetworkController({
      ...idleNetworkDeps,
      fetch: chainIdFetch("0x1"),
      rpc: {},
      openStore: async () => Promise.resolve(store),
      logger,
    });
    await c.init();
    expect(c.endpoints("eip155:1")).toStrictEqual(["https://saved.example"]);
  });

  it("persists a validated Bitcoin Esplora endpoint", async () => {
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: esploraFetch,
      rpc: {},
      openStore,
      logger,
    });
    await n.init();
    await n.addRpc(BTC.id, "https://esplora.example/api");
    expect(n.endpoints(BTC.id)).toStrictEqual(["https://esplora.example/api"]);
  });

  it("unlocks past a non-JSON custom endpoint row", async () => {
    const store = createMemoryEngineStore();
    await store.collection("networks").put("customRpc", new TextEncoder().encode("{torn"));
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: chainIdFetch("0x1"),
      rpc: { "eip155:1": ["https://host.example"] },
      openStore: async () => Promise.resolve(store),
      logger,
    });
    await n.init();
    expect(n.endpoints("eip155:1")).toStrictEqual(["https://host.example"]);
  });
});
