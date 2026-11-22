import { describe, expect, it } from "vite-plus/test";

import { networkById } from "@qntx/wallet-engine/gateway/contract";

import { healthy, runSmoke, smokePlan } from "../scripts/smoke-plan.ts";
import { localBudget } from "../src/budget/local.ts";
import { PRODUCTION_ACCOUNTS } from "../src/config/accounts.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";
import { fakeFetch, productionGateway, windowedCountBefore } from "./helpers.ts";
import { upstreamAnswer } from "./upstream-stub.ts";

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

/** `app.request` as a `fetch`: in-process, with the client IP the edge would have set. */
const appFetch =
  (app: ReturnType<typeof productionGateway>, ip: string): typeof globalThis.fetch =>
  async (input, init) => {
    const merged = new Headers(init?.headers);
    merged.set("cf-connecting-ip", ip);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return app.request(url, { ...init, headers: merged });
  };

describe("runSmoke", () => {
  it("passes every production check against the in-process production gateway", async () => {
    const upstream = fakeFetch({ "https://": upstreamAnswer });
    const app = productionGateway({
      fetch: upstream.fetch,
      share: windowedCountBefore(1000, 60_000, Date.now),
      budget: localBudget(PRODUCTION_ACCOUNTS, Date.now),
    });
    const result = await runSmoke({
      fetch: appFetch(app, "203.0.113.99"),
      baseUrl: "https://gateway.test",
      env: "production",
    });
    expect(result.failures).toStrictEqual([]);
  });
});
