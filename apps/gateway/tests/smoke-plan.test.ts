import { describe, expect, it } from "vite-plus/test";

import { networkById } from "@qntx/wallet-engine/gateway/contract";

import { healthy, smokePlan } from "../scripts/smoke-plan.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";

describe("smokePlan", () => {
  it.each([
    ["production", PRODUCTION_NETWORKS],
    ["staging", STAGING_NETWORKS],
  ] as const)("plans every configured %s network with its registry family", (_env, networks) => {
    expect(smokePlan(networks)).toStrictEqual(
      networks.map(({ id }) => ({ caip2: id, family: networkById(id)?.family })),
    );
    expect(smokePlan(networks).length).toBeGreaterThan(0);
  });

  it("maps a configured network to its family without resolving provider auth", () => {
    expect(
      smokePlan([{ id: "eip155:1", providers: [{ id: "a", url: "https://x", auth: "alchemy" }] }]),
    ).toStrictEqual([{ caip2: "eip155:1", family: "evm" }]);
  });

  it("throws for a configured id the registry lacks", () => {
    expect(() => smokePlan([{ id: "nope:0", providers: [] }])).toThrow("nope:0");
  });
});

describe("healthy", () => {
  it("accepts the contract health body", () => {
    expect(healthy({ status: "ok" })).toBe(true);
  });

  it.each([{}, { status: "down" }, null, "ok", 5, []])("rejects %j", (body) => {
    expect(healthy(body)).toBe(false);
  });
});
