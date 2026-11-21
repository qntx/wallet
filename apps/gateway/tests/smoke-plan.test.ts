import { describe, expect, it } from "vite-plus/test";

import { networkById } from "@qntx/wallet-engine/gateway/contract";

import { healthy, runSmoke, smokePlan } from "../scripts/smoke-plan.ts";
import { localBudget } from "../src/budget/local.ts";
import { PRODUCTION_ACCOUNTS } from "../src/config/accounts.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";
import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import { fakeFetch, productionGateway, rpcOk, windowedCountBefore } from "./helpers.ts";
import type { UpstreamCall } from "./helpers.ts";

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

/** Upstream URL → network id, looked up in the production provider table itself. */
const NETWORK_BY_PREFIX: ReadonlyArray<readonly [string, string]> = PRODUCTION_NETWORKS.flatMap(
  (network) => network.providers.map((provider) => [provider.url, network.id] as const),
);

/** CoinGecko's `/simple` wire shape: every requested id priced in the requested currency. */
const coingeckoPrices = (call: UpstreamCall): Response => {
  const url = new URL(call.url);
  const currency = url.searchParams.get("vs_currencies") ?? "usd";
  const ids = (url.searchParams.get("ids") ?? url.searchParams.get("contract_addresses") ?? "")
    .split(",")
    .filter((id) => id !== "");
  const now = Math.floor(Date.now() / 1000);
  return Response.json(
    Object.fromEntries(
      ids.map((id) => [
        id,
        { [currency]: 3000, [`${currency}_24h_change`]: 1.5, last_updated_at: now },
      ]),
    ),
  );
};

const defillamaKeys = (call: UpstreamCall): string[] =>
  call.url.split("/").pop()?.split("?")[0]?.split(",") ?? [];

/** DefiLlama's `/prices/current` wire shape: every requested key gets a fresh quote. */
const defillamaPrices = (call: UpstreamCall): Response =>
  Response.json({
    coins: Object.fromEntries(
      defillamaKeys(call).map((key) => [
        key,
        { price: 3000, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
      ]),
    ),
  });

/** DefiLlama's `/percentage` wire shape: a 24 h change per requested key. */
const defillamaChange = (call: UpstreamCall): Response =>
  Response.json({
    coins: Object.fromEntries(defillamaKeys(call).map((key) => [key, 1.5])),
  });

/** Answers every upstream call correctly for the network its provider URL serves. */
const upstreamAnswer = (call: UpstreamCall): Response => {
  if (call.url.startsWith(COINGECKO_API)) {
    return coingeckoPrices(call);
  }
  if (call.url.startsWith(`${DEFILLAMA_API}/percentage/`)) {
    return defillamaChange(call);
  }
  if (call.url.startsWith(DEFILLAMA_API)) {
    return defillamaPrices(call);
  }
  // RPC posts hit the provider URL itself; TRON and Esplora append a path — one provider URL
  // must not shadow another that shares its prefix (lb.drpc.live/arbitrum vs …/arbitrum-nova).
  const found = NETWORK_BY_PREFIX.find(
    ([prefix]) => call.url === prefix || call.url.startsWith(`${prefix}/`),
  );
  if (found === undefined) {
    throw new Error(`no upstream stub for ${call.url}`);
  }
  const [, id] = found;
  const info = networkById(id);
  if (info === undefined) {
    throw new Error(`configured network ${id} is not in the registry`);
  }
  if (info.family === "tron") {
    return Response.json({ chainParameter: [{ key: "getTransactionFee", value: 1 }] });
  }
  if (info.family === "bitcoin") {
    return new Response(info.genesisHash ?? "");
  }
  const body = JSON.parse(call.body) as { method?: string };
  if (body.method === "eth_chainId") {
    return rpcOk(`0x${BigInt(id.split(":")[1] ?? "0").toString(16)}`);
  }
  if (body.method === "getGenesisHash") {
    return rpcOk(info.genesisHash ?? "");
  }
  return rpcOk({});
};

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
