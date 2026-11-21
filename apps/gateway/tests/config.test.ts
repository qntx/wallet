import { describe, expect, it } from "vite-plus/test";

import { NETWORKS } from "@qntx/wallet-engine/gateway/contract";

import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";

const evmMainnets = NETWORKS.filter((n) => n.family === "evm" && !n.testnet).map((n) => n.id);
const evmTestnets = NETWORKS.filter((n) => n.family === "evm" && n.testnet).map((n) => n.id);
const evmOf = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
  ids.filter((id) => id.startsWith("eip155:"));

describe("gateway network config", () => {
  it("serves every registry EVM mainnet in production, in registry order", () => {
    expect(evmOf(PRODUCTION_NETWORKS.map((n) => n.id))).toStrictEqual(evmMainnets);
  });

  it("serves every registry EVM testnet in staging, in registry order", () => {
    expect(evmOf(STAGING_NETWORKS.map((n) => n.id))).toStrictEqual(evmTestnets);
  });

  it("gives every production EVM network exactly alchemy then drpc, or drpc then ankr", () => {
    for (const network of PRODUCTION_NETWORKS.filter((n) => n.id.startsWith("eip155:"))) {
      expect(["alchemy,drpc", "drpc,ankr"]).toContain(network.providers.map((p) => p.id).join(","));
      expect(network.providers.every((p) => p.auth !== undefined)).toBe(true);
    }
  });

  it("serves exactly the Alchemy-unserved mainnets through dRPC then Ankr", () => {
    const ankr = PRODUCTION_NETWORKS.filter((n) => n.providers.some((p) => p.auth === "ankr")).map(
      (n) => n.id,
    );
    expect(ankr).toStrictEqual(["eip155:42170", "eip155:167000", "eip155:14"]);
  });

  it("keeps every staging provider keyless", () => {
    for (const network of STAGING_NETWORKS) {
      expect(network.providers.every((p) => p.auth === undefined)).toBe(true);
    }
  });

  it("keeps provider ids unique within each network", () => {
    for (const network of [...PRODUCTION_NETWORKS, ...STAGING_NETWORKS]) {
      expect(new Set(network.providers.map((p) => p.id)).size).toBe(network.providers.length);
    }
  });
});
