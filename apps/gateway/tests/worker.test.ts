import { describe, expect, it } from "vite-plus/test";

import { EVM_RPC_METHODS, SOLANA_RPC_METHODS } from "@qntx/wallet-engine/gateway/contract";

import { createGateway } from "../src/app.ts";
import { ALCHEMY_COSTS, DRPC_COSTS } from "../src/budget/costs.ts";
import type { CostModel, CostRow } from "../src/budget/costs.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";
import { gatewayFor, priceCacheOf, riskStoreOf } from "../src/worker.ts";
import type { WorkerEnv } from "../src/worker.ts";
import { allowAll } from "./helpers.ts";

const rpcMethods = (model: CostModel): Readonly<Record<string, CostRow>> =>
  model.kind === "rpc" ? model.methods : {};

const kv = (): KVNamespace =>
  ({
    get: async () => Promise.resolve(null),
    put: async () => Promise.resolve(),
  }) as unknown as KVNamespace;

/** A PROVIDER_BUDGET namespace whose stub always grants — env shape only, never exercised here. */
const budgetNs = () =>
  ({
    idFromName: (name: string) => name,
    get: () => ({
      lease: async () => Promise.resolve({ ok: true as const, granted: 0 }),
    }),
  }) as unknown as WorkerEnv["PROVIDER_BUDGET"];

const staging = (over: Partial<WorkerEnv> = {}): WorkerEnv =>
  ({
    RISK: kv(),
    IP_LIMITER: allowAll,
    RPC_LIMITER: allowAll,
    DEFAULT_LIMITER: allowAll,
    SHARE_LIMITER: allowAll,
    PROVIDER_BUDGET: budgetNs(),
    CORS_ORIGINS: "http://localhost:5173,http://localhost:8081",
    NETWORKS: "staging",
    ZEROX_API_KEY: "z",
    ...over,
  }) as WorkerEnv;

const production = (over: Partial<WorkerEnv> = {}): WorkerEnv =>
  ({
    RISK: kv(),
    IP_LIMITER: allowAll,
    RPC_LIMITER: allowAll,
    DEFAULT_LIMITER: allowAll,
    SHARE_LIMITER: allowAll,
    PROVIDER_BUDGET: budgetNs(),
    CORS_ORIGINS: "",
    NETWORKS: "production",
    ZEROX_API_KEY: "z",
    JUPITER_API_KEY: "j",
    ALCHEMY_API_KEY: "a",
    DRPC_API_KEY: "d",
    ANKR_API_KEY: "n",
    BLOCKSTREAM_CLIENT_ID: "id",
    BLOCKSTREAM_CLIENT_SECRET: "sec",
    COINGECKO_API_KEY: "cg",
    ...over,
  }) as WorkerEnv;

describe("gatewayFor", () => {
  it("production yields mainnets and all four provider auths", () => {
    const options = gatewayFor(production());
    expect(options.networks).toBe(PRODUCTION_NETWORKS);
    expect(Object.keys(options.auth).toSorted()).toStrictEqual([
      "alchemy",
      "ankr",
      "blockstream",
      "drpc",
    ]);
    expect(options.corsOrigins).toStrictEqual([]);
    expect(gatewayFor(production({ CORS_ORIGINS: "" })).corsOrigins).toStrictEqual([]);
    expect(options.jupiter).toStrictEqual({ apiKey: "j" });
    expect(options.zeroEx?.apiKey).toBe("z");
    expect(options.prices.coingecko).toStrictEqual({ apiKey: "cg" });
    expect(() => createGateway(options)).not.toThrow();
  });

  it("staging yields testnets, no auths, and the configured origins", () => {
    const options = gatewayFor(staging());
    expect(options.networks).toBe(STAGING_NETWORKS);
    expect(options.auth).toStrictEqual({});
    expect(options.corsOrigins).toStrictEqual(["http://localhost:5173", "http://localhost:8081"]);
    expect(options.jupiter).toBeUndefined();
    expect(options.prices.coingecko).toBeUndefined();
    expect(gatewayFor(staging({ COINGECKO_API_KEY: "cg2" })).prices.coingecko).toStrictEqual({
      apiKey: "cg2",
    });
    expect(() => createGateway(options)).not.toThrow();
  });

  it("prices every allow-listed method in both RPC cost tables", () => {
    for (const table of [ALCHEMY_COSTS, DRPC_COSTS].map((m) => rpcMethods(m))) {
      for (const method of [...EVM_RPC_METHODS, ...SOLANA_RPC_METHODS]) {
        const row = table[method];
        expect(row).toBeDefined();
        expect(row?.units).toBeGreaterThanOrEqual(0);
        expect(row?.source).toMatch(/^https:\/\//);
      }
    }
  });

  it("optional quote config passes through per env shape", () => {
    expect(gatewayFor(staging({ JUPITER_API_KEY: "j2" })).jupiter).toStrictEqual({
      apiKey: "j2",
    });
    expect(
      gatewayFor(
        production({
          ZEROX_FEE_RECIPIENT: "0x0000000000000000000000000000000000000001",
          ZEROX_FEE_BPS: "10",
        }),
      ).zeroEx?.fee,
    ).toStrictEqual({ recipient: "0x0000000000000000000000000000000000000001", bps: 10 });
  });
});

describe("riskStoreOf", () => {
  it("adapts the KV namespace to the RiskStore interface", async () => {
    const store = riskStoreOf(kv());
    await store.put("k", "v");
    await expect(store.get("k")).resolves.toBeUndefined();
  });
});

describe("priceCacheOf", () => {
  it("stores each entry under a synthetic URL with its TTL as max-age", async () => {
    const stored = new Map<string, Response>();
    const cache = {
      match: async (key: string) => Promise.resolve(stored.get(key)?.clone()),
      put: async (key: string, response: Response) => {
        stored.set(key, response);
        return Promise.resolve();
      },
    };
    // The fake implements only the two Cache methods the adapter calls.
    const prices = priceCacheOf(() => cache as unknown as Cache);
    await expect(prices.get("usd/x")).resolves.toBeUndefined();
    await prices.put("usd/eip155:1/slip44:60", '{"v":1}', 30);
    const [[key, response] = ["", new Response()]] = [...stored];
    expect(key).toBe("https://prices.cache.invalid/usd/eip155:1/slip44:60");
    expect(response.headers.get("cache-control")).toBe("max-age=30");
    await expect(prices.get("usd/eip155:1/slip44:60")).resolves.toBe('{"v":1}');
  });
});
