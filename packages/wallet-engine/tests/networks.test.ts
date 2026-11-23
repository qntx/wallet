import { base58 } from "@scure/base";
import { getAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_NETWORKS } from "@qntx/wallet-chains/networks";

import { NetworkController } from "../src/networks/controller.ts";
import type { Independent } from "../src/networks/controller.ts";
import type { FeeModel, NetworkInfo } from "../src/networks/registry.ts";
import {
  BITCOIN_NETWORKS,
  DELEGATOR_CODE_HASHES,
  EVM_FACTS,
  NETWORKS,
  SOLANA_NETWORKS,
} from "../src/networks/registry.ts";
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
  it("marks exactly the OP Stack chains with the op-stack fee model", () => {
    expect(
      NETWORKS.filter((n) => n.feeModel?.kind === "op-stack")
        .map((n) => n.chainId)
        .toSorted((a, b) => a - b),
    ).toStrictEqual([
      10, 130, 196, 204, 252, 480, 1301, 1868, 1946, 1952, 2020, 2523, 4326, 5000, 5003, 5611, 8453,
      42220, 57073, 60808, 84532, 747474, 763373, 7777777, 11142220, 11155420, 999999999,
    ]);
  });

  it("sets tokenRatio exactly on the Mantle chains", () => {
    const opStack = NETWORKS.filter(
      (n): n is NetworkInfo & { readonly feeModel: Extract<FeeModel, { kind: "op-stack" }> } =>
        n.feeModel?.kind === "op-stack",
    );
    expect(opStack.filter((n) => n.feeModel.tokenRatio).map((n) => n.id)).toStrictEqual([
      "eip155:5000",
      "eip155:5003",
    ]);
  });

  it("prices legacy exactly on Fraxtal and opBNB", () => {
    expect(NETWORKS.filter((n) => n.feeModel?.pricing === "legacy").map((n) => n.id)).toStrictEqual(
      ["eip155:252", "eip155:204", "eip155:5611"],
    );
  });

  it("marks exactly Scroll with the scroll fee model", () => {
    expect(NETWORKS.filter((n) => n.feeModel?.kind === "scroll").map((n) => n.id)).toStrictEqual([
      "eip155:534352",
    ]);
  });

  it("skips the operator fee exactly on the opBNB chains", () => {
    const opStack = NETWORKS.filter(
      (n): n is NetworkInfo & { readonly feeModel: Extract<FeeModel, { kind: "op-stack" }> } =>
        n.feeModel?.kind === "op-stack",
    );
    expect(opStack.filter((n) => !n.feeModel.operatorFee).map((n) => n.id)).toStrictEqual([
      "eip155:204",
      "eip155:5611",
    ]);
  });

  it("uses the ZKsync Multicall3 only on the ZKsync chains, canonical elsewhere", () => {
    const ZKSYNC = "0xF9cda624FBC7e059355ce98a31693d299FACd963";
    const CANONICAL = "0xcA11bde05977b3631167028862bE2a173976CA11";
    const evm = NETWORKS.filter((n) => n.family === "evm");
    const expected: Record<string, string> = Object.fromEntries(evm.map((n) => [n.id, CANONICAL]));
    expected["eip155:324"] = ZKSYNC;
    expected["eip155:300"] = ZKSYNC;
    expect(Object.fromEntries(evm.map((n) => [n.id, n.multicall3]))).toStrictEqual(expected);
  });

  it("covers every built-in EVM chain in order, with one facts entry each", () => {
    const evm = BUILT_IN_NETWORKS.filter((n) => n.family === "evm");
    expect(NETWORKS.map((n) => n.id)).toStrictEqual(evm.map((n) => n.id));
    expect(
      Object.keys(EVM_FACTS)
        .map(Number)
        .toSorted((a, b) => a - b),
    ).toStrictEqual(evm.map((n) => n.chainId).toSorted((a, b) => a - b));
  });

  it("has unique built-in ids and unique EVM chainIds matching the eip155 id", () => {
    const ids = BUILT_IN_NETWORKS.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chainIds = NETWORKS.map((n) => n.chainId);
    expect(new Set(chainIds).size).toBe(chainIds.length);
    for (const network of NETWORKS) {
      expect(network.id).toBe(`eip155:${network.chainId}`);
    }
  });

  it.each(NETWORKS)("$id has a fee model and a checksummed Multicall3 address", (network) => {
    expect(network.feeModel).toBeDefined();
    expect(network.multicall3).toBeDefined();
    expect(getAddress(String(network.multicall3))).toBe(network.multicall3);
  });

  it("keys DELEGATOR_CODE_HASHES by a registry chain with 32-byte hashes", () => {
    const chainIds = new Set(NETWORKS.map((n) => n.chainId));
    for (const [key, hash] of Object.entries(DELEGATOR_CODE_HASHES)) {
      expect(chainIds.has(Number(key))).toBe(true);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("lists exactly the chains with a deployed delegator and a mined 7702 transaction", () => {
    expect(
      Object.keys(DELEGATOR_CODE_HASHES)
        .map(Number)
        .toSorted((a, b) => a - b),
    ).toStrictEqual([
      1, 10, 56, 97, 100, 137, 143, 4663, 5000, 8453, 9745, 42161, 42220, 57073, 59144, 80002,
      84532, 421614, 11155111, 11155420,
    ]);
  });

  it("keeps feeModel and multicall3 off the non-EVM entries", () => {
    for (const network of [...SOLANA_NETWORKS, ...BITCOIN_NETWORKS]) {
      expect(network.feeModel).toBeUndefined();
      expect(network.multicall3).toBeUndefined();
    }
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

  it("fails over a non-JSON Solana answer with the HTTP status and endpoint", async () => {
    const badGateway = (async () =>
      Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 }))) as typeof fetch;
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: badGateway,
      rpc: { [DEVNET]: ["https://rpc-a.example", "https://rpc-b.example"] },
      openStore,
      logger,
    });
    await n.init();
    const rpc = n.solanaRpc(DEVNET);
    await expect(rpc.call("getBalance", ["owner"])).rejects.toThrow(
      "getBalance: HTTP 502 from https://rpc-b.example",
    );
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

describe("a custom endpoint is never its own corroborator", () => {
  const GATEWAY = "https://gateway.test";
  const NILE = "tron:3448148188";
  const NILE_GENESIS = "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc";
  const SOL_CUSTOM = "https://sol-custom.example";
  const TRON_CUSTOM = "https://tron-custom.example";
  const SOL_HOST = "https://sol-host.example";

  type Seen = { readonly url: string; readonly method: string; readonly clientId: string | null };

  const available = <T>(independent: Independent<T>): T => {
    if (independent.kind !== "available") {
      throw new Error(`expected an available independent, got ${independent.kind}`);
    }
    return independent.client;
  };

  /* A fetch that answers the served-networks list, the custom endpoints' add-time probes, and
     the corroborator's calls — recording the URL, the JSON-RPC method and the client id each
     saw. */
  const rig = async (options: {
    served: ReadonlyArray<string>;
    rpc?: Readonly<Record<string, ReadonlyArray<string>>>;
    gateway?: boolean;
  }) => {
    const seen: Seen[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const base = url.endsWith("/") ? url.slice(0, -1) : url;
      if (url === `${GATEWAY}/v1/networks`) {
        return Response.json({ networks: options.served });
      }
      const body =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as { method?: string });
      seen.push({
        url,
        method: body?.method ?? "",
        clientId: new Headers(init?.headers).get("x-client-id"),
      });
      if (base === SOL_CUSTOM || base === SOL_HOST || base === `${GATEWAY}/v1/rpc/${DEVNET}`) {
        return Response.json({ jsonrpc: "2.0", id: 1, result: DEVNET_GENESIS });
      }
      if (
        base === `${TRON_CUSTOM}/wallet/getblockbynum` ||
        base === `${GATEWAY}/v1/tron/${NILE}/wallet/getblockbynum`
      ) {
        return Response.json({ blockID: NILE_GENESIS });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch,
      rpc: options.rpc ?? {},
      openStore,
      logger,
      ...(options.gateway === false
        ? {}
        : {
            gateway: {
              url: GATEWAY,
              clientIds: { evm: "e", solana: "s", bitcoin: "b", tron: "t", service: "svc" },
            },
          }),
    });
    await networks.init();
    return { networks, seen };
  };

  it("a custom endpoint is corroborated by the host endpoint, never by itself", async () => {
    const { networks, seen } = await rig({
      served: [DEVNET, NILE],
      rpc: { [DEVNET]: [SOL_HOST] },
    });
    await networks.addRpc(DEVNET, SOL_CUSTOM);
    const independent = networks.independentSolanaRpc(DEVNET);
    expect(independent).toMatchObject({ kind: "available", source: "host" });
    await expect(available(independent).call("getGenesisHash", [])).resolves.toBe(DEVNET_GENESIS);
    // The corroborating read went to the host URL on the plain fetch — no client id.
    expect(seen.at(-1)).toStrictEqual({
      url: SOL_HOST,
      method: "getGenesisHash",
      clientId: null,
    });
    // The primary reads still belong to the custom endpoint alone.
    expect(networks.endpoints(DEVNET)).toStrictEqual([SOL_CUSTOM, SOL_HOST]);
  });

  it("a custom endpoint on a host-less network is corroborated by the gateway it bypassed", async () => {
    const { networks, seen } = await rig({ served: [DEVNET, NILE] });
    await networks.addRpc(DEVNET, SOL_CUSTOM);
    await networks.addRpc(NILE, TRON_CUSTOM);
    const solana = networks.independentSolanaRpc(DEVNET);
    const tron = networks.independentTronApi(NILE);
    expect(solana).toMatchObject({ kind: "available", source: "gateway" });
    expect(tron).toMatchObject({ kind: "available", source: "gateway" });
    await available(solana).call("getGenesisHash", []);
    await available(tron).post("/wallet/getblockbynum", { num: 0 });
    expect(seen.at(-2)).toStrictEqual({
      url: `${GATEWAY}/v1/rpc/${DEVNET}`,
      method: "getGenesisHash",
      clientId: "s",
    });
    expect(seen.at(-1)).toStrictEqual({
      url: `${GATEWAY}/v1/tron/${NILE}/wallet/getblockbynum`,
      method: "",
      clientId: "t",
    });
    expect(networks.endpoints(DEVNET)).toStrictEqual([SOL_CUSTOM]);
    expect(networks.endpoints(NILE)).toStrictEqual([TRON_CUSTOM]);
  });

  it("a custom endpoint with neither host nor gateway leaves the cross-check unavailable", async () => {
    const { networks } = await rig({ served: [] });
    await networks.addRpc(DEVNET, SOL_CUSTOM);
    await networks.addRpc(NILE, TRON_CUSTOM);
    expect(networks.independentSolanaRpc(DEVNET).kind).toBe("unavailable");
    expect(networks.independentTronApi(NILE).kind).toBe("unavailable");
  });

  it("without a gateway a custom endpoint corroborates on the host or stays unavailable", async () => {
    const { networks } = await rig({
      served: [],
      gateway: false,
      rpc: { [DEVNET]: [SOL_HOST] },
    });
    expect(networks.independentSolanaRpc(DEVNET).kind).toBe("not-needed");
    await networks.addRpc(DEVNET, SOL_CUSTOM);
    expect(networks.independentSolanaRpc(DEVNET)).toMatchObject({
      kind: "available",
      source: "host",
    });

    const hostless = await rig({ served: [], gateway: false });
    await hostless.networks.addRpc(DEVNET, SOL_CUSTOM);
    expect(hostless.networks.independentSolanaRpc(DEVNET).kind).toBe("unavailable");
  });

  it("a gateway-first network still corroborates on the host or stays unavailable", async () => {
    const { networks } = await rig({ served: [DEVNET], rpc: { [DEVNET]: [SOL_HOST] } });
    expect(networks.independentSolanaRpc(DEVNET)).toMatchObject({
      kind: "available",
      source: "host",
    });
    const hostless = await rig({ served: [DEVNET] });
    expect(hostless.networks.independentSolanaRpc(DEVNET).kind).toBe("unavailable");
  });
});
