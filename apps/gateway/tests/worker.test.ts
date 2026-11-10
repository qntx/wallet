import { describe, expect, it } from "vite-plus/test";

import { createGateway } from "../src/app.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";
import { gatewayFor, riskStoreOf } from "../src/worker.ts";
import type { WorkerEnv } from "../src/worker.ts";
import { allowAll } from "./helpers.ts";

const kv = (): KVNamespace =>
  ({
    get: async () => Promise.resolve(null),
    put: async () => Promise.resolve(),
  }) as unknown as KVNamespace;

const staging = (over: Partial<WorkerEnv> = {}): WorkerEnv =>
  ({
    RISK: kv(),
    IP_LIMITER: allowAll,
    RPC_LIMITER: allowAll,
    DEFAULT_LIMITER: allowAll,
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
    CORS_ORIGINS: "",
    NETWORKS: "production",
    ZEROX_API_KEY: "z",
    JUPITER_API_KEY: "j",
    ALCHEMY_API_KEY: "a",
    DRPC_API_KEY: "d",
    BLOCKSTREAM_CLIENT_ID: "id",
    BLOCKSTREAM_CLIENT_SECRET: "sec",
    ...over,
  }) as WorkerEnv;

describe("gatewayFor", () => {
  it("production yields mainnets and all three provider auths", () => {
    const options = gatewayFor(production());
    expect(options.networks).toBe(PRODUCTION_NETWORKS);
    expect(Object.keys(options.auth).toSorted()).toStrictEqual(["alchemy", "blockstream", "drpc"]);
    expect(options.corsOrigins).toStrictEqual([]);
    expect(gatewayFor(production({ CORS_ORIGINS: "" })).corsOrigins).toStrictEqual([]);
    expect(options.jupiter).toStrictEqual({ apiKey: "j" });
    expect(options.zeroEx?.apiKey).toBe("z");
    expect(() => createGateway(options)).not.toThrow();
  });

  it("staging yields testnets, no auths, and the configured origins", () => {
    const options = gatewayFor(staging());
    expect(options.networks).toBe(STAGING_NETWORKS);
    expect(options.auth).toStrictEqual({});
    expect(options.corsOrigins).toStrictEqual(["http://localhost:5173", "http://localhost:8081"]);
    expect(options.jupiter).toBeUndefined();
    expect(() => createGateway(options)).not.toThrow();
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
