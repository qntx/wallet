import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  PROVIDER_PIN_HEADER,
  TRON_INDEXER_PATHS,
  TRON_NODE_PATHS,
  gatewayError,
} from "@qntx/wallet-engine/gateway/contract";

import type { GatewayNetwork } from "../src/types.ts";
import {
  SEPOLIA,
  allowAll,
  expectContract,
  fakeFetch,
  gateway,
  headers,
  post,
  recordingLimiter,
} from "./helpers.ts";

const NILE = "tron:3448148188";
const BASE = `/v1/tron/${NILE}`;

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  {
    id: NILE,
    providers: [
      { id: "trongrid", url: "https://a.test/tron" },
      { id: "b", url: "https://b.test/tron" },
    ],
  },
];

const HOLDER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";
const UNKNOWN = "TEWNZeMfMLjtcrbrZ1N6reGQts3a2MC2xp";
const TXID = "cd".repeat(32);

const app = (up: ReturnType<typeof fakeFetch>) => gateway({ fetch: up.fetch, networks: NETWORKS });

describe("tron route", () => {
  it("forwards an allow-listed node path with its body to the first provider", async () => {
    const up = fakeFetch({
      "https://a.test/tron": (call) => {
        expect(call.url).toBe("https://a.test/tron/wallet/getchainparameters");
        expect(call.method).toBe("POST");
        expect(call.body).toBe("{}");
        return Response.json({ chainParameter: [{ key: "getTransactionFee", value: 1000 }] });
      },
    });
    const res = await app(up).request(`${BASE}/wallet/getchainparameters`, post({}));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("trongrid");
    await expect(res.json()).resolves.toStrictEqual({
      chainParameter: [{ key: "getTransactionFee", value: 1000 }],
    });
  });

  it("400s a path outside the allow-list without calling upstream", async () => {
    const up = fakeFetch({});
    const res = await app(up).request(`${BASE}/wallet/getaccountbyid`, post({}));
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it.each([
    ["a non-JSON body", "not json", "/wallet/getchainparameters"],
    ["a missing visible flag", JSON.stringify({ address: HOLDER }), "/wallet/getaccount"],
    [
      "a non-TRON address",
      JSON.stringify({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", visible: true }),
      "/wallet/getaccount",
    ],
    ["a negative block number", JSON.stringify({ num: -1 }), "/wallet/getblockbynum"],
    [
      "odd-length calldata",
      JSON.stringify({
        owner_address: HOLDER,
        contract_address: HOLDER,
        data: "a9059cb",
        visible: true,
      }),
      "/wallet/triggerconstantcontract",
    ],
    [
      "a non-hex txid",
      JSON.stringify({ value: "zz".repeat(32) }),
      "/wallet/gettransactioninfobyid",
    ],
    [
      "an indexer limit above 50",
      JSON.stringify({ address: HOLDER, limit: 51 }),
      "/v1/accounts/transactions",
    ],
  ])("400s %s without calling upstream", async (_name, body, path) => {
    const up = fakeFetch({});
    const res = await app(up).request(`${BASE}${path}`, post(body));
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it("404s a network the gateway does not serve for the family", async () => {
    const up = fakeFetch({});
    const res = await app(up).request(`/v1/tron/${SEPOLIA}/wallet/getchainparameters`, post({}));
    expect(res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it.each([
    ["/wallet/getchainparameters", {}],
    ["/wallet/getnowblock", {}],
    ["/v1/accounts/transactions", { address: HOLDER }],
  ])("bills one request credit on the provider account for %s", async (path, body) => {
    const share = recordingLimiter();
    const up = fakeFetch({
      "https://a.test/tron": () => Response.json(costFixture(path)),
    });
    const res = await gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share },
    }).request(`${BASE}${path}`, post(body));
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    expect(share.keys).toStrictEqual(["trongrid:unknown"]);
    expect(share.deltas.every((delta) => delta >= 1)).toBe(true);
  });

  const costFixture = (path: string): Record<string, unknown> => {
    switch (path) {
      case "/v1/accounts/transactions":
        return { success: true, data: [], meta: {} };
      case "/wallet/getnowblock":
        return {
          blockID: "ab".repeat(32),
          block_header: { raw_data: { number: 1, timestamp: 1 } },
        };
      default:
        return { chainParameter: [] };
    }
  };

  it("fails over on a malformed provider answer without counting the breaker", async () => {
    // Six malformed answers would open the breaker if each counted; the seventh still reaches a.
    for (let i = 0; i < 7; i += 1) {
      const up = fakeFetch({
        "https://a.test/tron": () => Response.json({ Error: "unexpected" }),
        "https://b.test/tron": () => Response.json({ chainParameter: [] }),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential breaker-count checks
      const res = await app(up).request(`${BASE}/wallet/getchainparameters`, post({}));
      expect(res.status).toBe(200);
      expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
      expect(up.callsTo("https://a.test")).toHaveLength(1);
    }
  });

  it("fails over on a 5xx and reports the surviving provider", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () => new Response("down", { status: 502 }),
      "https://b.test/tron": () => Response.json({ chainParameter: [] }),
    });
    const res = await app(up).request(`${BASE}/wallet/getchainparameters`, post({}));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
  });

  it("serves a node request naming a provider pin from that provider only", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () => Response.json({ chainParameter: [] }),
      "https://b.test/tron": () => Response.json({ chainParameter: [{ key: "k", value: 1 }] }),
    });
    const res = await app(up).request(`${BASE}/wallet/getchainparameters`, {
      ...post({}),
      headers: headers({ "content-type": "application/json", [PROVIDER_PIN_HEADER]: "b" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    expect(up.callsTo("https://a.test")).toHaveLength(0);
    await expect(res.json()).resolves.toStrictEqual({ chainParameter: [{ key: "k", value: 1 }] });
  });

  it("does not fail over off a pinned provider — its failure is the answer", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () => Response.json({ chainParameter: [] }),
      "https://b.test/tron": () => new Response("down", { status: 502 }),
    });
    const res = await app(up).request(`${BASE}/wallet/getchainparameters`, {
      ...post({}),
      headers: headers({ "content-type": "application/json", [PROVIDER_PIN_HEADER]: "b" }),
    });
    expect(res.status).toBe(503);
    expect(up.callsTo("https://a.test")).toHaveLength(0);
  });

  it("400s a node request naming a provider pin that does not exist", async () => {
    const up = fakeFetch({});
    const res = await app(up).request(`${BASE}/wallet/getchainparameters`, {
      ...post({}),
      headers: headers({ "content-type": "application/json", [PROVIDER_PIN_HEADER]: "nobody" }),
    });
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it("answers 503 when every provider fails", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () => new Response("down", { status: 502 }),
      "https://b.test/tron": () => new Response("down", { status: 502 }),
    });
    const res = await app(up).request(`${BASE}/wallet/getchainparameters`, post({}));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("answers 502 on a broadcast with an unknown outcome — no failover", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () => new Response("<html>", { status: 200 }),
      "https://b.test/tron": () => Response.json({ result: true, txid: TXID }),
    });
    const res = await app(up).request(
      `${BASE}/wallet/broadcasthex`,
      post({ transaction: "00".repeat(32) }),
    );
    expect(res.status).toBe(502);
    await expectContract(res, gatewayError);
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("relays a broadcast refusal verbatim", async () => {
    const refusal = { result: false, code: "SIGERROR", message: "Validate signature error: x" };
    const up = fakeFetch({
      "https://a.test/tron": () => Response.json(refusal),
    });
    const res = await app(up).request(
      `${BASE}/wallet/broadcasthex`,
      post({ transaction: "00".repeat(32) }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual(refusal);
  });

  it("400s a provider answer above 4 MiB without failover", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () =>
        new Response("{}", {
          headers: { "content-length": String(5 * 1024 * 1024) },
        }),
      "https://b.test/tron": () => Response.json({ chainParameter: [] }),
    });
    const res = await app(up).request(`${BASE}/wallet/getchainparameters`, post({}));
    expect(res.status).toBe(400);
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });
});

describe("tron indexer", () => {
  const page = { success: true, data: [], meta: {} };

  it("translates a page request to the TronGrid GET form", async () => {
    const up = fakeFetch({
      "https://a.test/tron": (call) => {
        expect(call.method).toBe("GET");
        expect(call.url).toBe(
          `https://a.test/tron/v1/accounts/${HOLDER}/transactions?only_confirmed=true&limit=10`,
        );
        return Response.json(page);
      },
    });
    const res = await app(up).request(
      `${BASE}/v1/accounts/transactions`,
      post({ address: HOLDER, limit: 10 }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual(page);
  });

  it("defaults the page size and forwards a fingerprint", async () => {
    const up = fakeFetch({
      "https://a.test/tron": (call) => {
        expect(call.url).toBe(
          `https://a.test/tron/v1/accounts/${HOLDER}/transactions/trc20` +
            "?only_confirmed=true&limit=50&fingerprint=abc123",
        );
        return Response.json(page);
      },
    });
    const res = await app(up).request(
      `${BASE}/v1/accounts/transactions/trc20`,
      post({ address: HOLDER, fingerprint: "abc123" }),
    );
    expect(res.status).toBe(200);
  });

  it("translates the account path without a query string", async () => {
    const up = fakeFetch({
      "https://a.test/tron": (call) => {
        expect(call.url).toBe(`https://a.test/tron/v1/accounts/${HOLDER}`);
        return Response.json({ success: true, data: [{}], meta: {} });
      },
    });
    const res = await app(up).request(`${BASE}/v1/accounts/account`, post({ address: HOLDER }));
    expect(res.status).toBe(200);
  });

  it("400s an indexer path naming a provider pin — before any upstream call", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () => Response.json(page),
      "https://b.test/tron": () => Response.json(page),
    });
    const res = await app(up).request(`${BASE}/v1/accounts/account`, {
      ...post({ address: HOLDER }),
      headers: headers({ "content-type": "application/json", [PROVIDER_PIN_HEADER]: "b" }),
    });
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it("never sends indexer paths to a node-only provider", async () => {
    const up = fakeFetch({
      "https://a.test/tron": () => new Response("down", { status: 502 }),
      "https://b.test/tron": () => Response.json(page),
    });
    const res = await app(up).request(
      `${BASE}/v1/accounts/transactions`,
      post({ address: HOLDER }),
    );
    expect(res.status).toBe(503);
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("answers 503 for an indexer path on a network without an indexer provider", async () => {
    const up = fakeFetch({ "https://a.test/tron": () => Response.json(page) });
    const res = await gateway({
      fetch: up.fetch,
      networks: [{ id: NILE, providers: [{ id: "b", url: "https://a.test/tron" }] }],
    }).request(`${BASE}/v1/accounts/transactions`, post({ address: HOLDER }));
    expect(res.status).toBe(503);
    expect(up.calls).toHaveLength(0);
  });
});

describe("tron recorded fixtures", () => {
  const dir = join(import.meta.dirname, "fixtures", "tron", "mainnet-trongrid");
  const fixture = (name: string): { status: number; body: unknown } =>
    JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as {
      status: number;
      body: unknown;
    };
  const files = new Set(readdirSync(dir));

  const nodeFixtures: ReadonlyArray<readonly [string, string, unknown]> = [
    ["nowblock-full", "/wallet/getnowblock", {}],
    ["nowblock-solidity", "/walletsolidity/getnowblock", {}],
    ["blockbynum-full", "/wallet/getblockbynum", { num: 1 }],
    ["blockbynum-solidity", "/walletsolidity/getblockbynum", { num: 1 }],
    ["account-holder", "/wallet/getaccount", { address: HOLDER, visible: true }],
    ["account-unknown", "/wallet/getaccount", { address: UNKNOWN, visible: true }],
    ["accountresource", "/wallet/getaccountresource", { address: HOLDER, visible: true }],
    ["chainparameters", "/wallet/getchainparameters", {}],
    [
      "triggerconstantcontract",
      "/wallet/triggerconstantcontract",
      {
        owner_address: HOLDER,
        contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        data: `a9059cbb${"00".repeat(32)}${"00".repeat(32)}`,
        visible: true,
      },
    ],
    ["broadcasthex", "/wallet/broadcasthex", { transaction: "00".repeat(32) }],
    ["transactionbyid", "/wallet/gettransactionbyid", { value: TXID }],
    ["transactionbyid-bogus", "/wallet/gettransactionbyid", { value: "ab".repeat(32) }],
    ["transactioninfobyid", "/wallet/gettransactioninfobyid", { value: TXID }],
    ["transactioninfobyid-solidity", "/walletsolidity/gettransactioninfobyid", { value: TXID }],
    [
      "availableunfreezecount",
      "/wallet/getavailableunfreezecount",
      { owner_address: HOLDER, visible: true },
    ],
    [
      "candelegatedmaxsize-bandwidth",
      "/wallet/getcandelegatedmaxsize",
      { owner_address: HOLDER, type: 0, visible: true },
    ],
    [
      "candelegatedmaxsize-energy",
      "/wallet/getcandelegatedmaxsize",
      { owner_address: HOLDER, type: 1, visible: true },
    ],
    [
      "delegatedresourcev2",
      "/wallet/getdelegatedresourcev2",
      { fromAddress: HOLDER, toAddress: UNKNOWN, visible: true },
    ],
    ["getreward", "/wallet/getReward", { address: HOLDER, visible: true }],
    ["listwitnesses", "/wallet/listwitnesses", {}],
    ["assetissuebyid", "/wallet/getassetissuebyid", { value: 1002000 }],
  ];

  it.each(nodeFixtures.filter(([name]) => files.has(`${name}.json`)))(
    "round-trips %s through the route",
    async (name, path, body) => {
      const recorded = fixture(name);
      expect(recorded.status).toBe(200);
      const up = fakeFetch({
        "https://a.test/tron": () => Response.json(recorded.body),
      });
      const res = await app(up).request(`${BASE}${path}`, post(body));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual(recorded.body);
    },
  );

  const indexerFixtures: ReadonlyArray<readonly [string, string]> = [
    ["v1-accounts-transactions", "/v1/accounts/transactions"],
    ["v1-accounts-transactions-trc20", "/v1/accounts/transactions/trc20"],
    ["v1-accounts-account", "/v1/accounts/account"],
  ];

  it.each(indexerFixtures.filter(([name]) => files.has(`${name}.json`)))(
    "round-trips the recorded indexer %s",
    async (name, path) => {
      const recorded = fixture(name);
      expect(recorded.status).toBe(200);
      const up = fakeFetch({
        "https://a.test/tron": () => Response.json(recorded.body),
      });
      const res = await app(up).request(`${BASE}${path}`, post({ address: HOLDER }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual(recorded.body);
    },
  );

  it("recorded every allow-listed node path", () => {
    for (const [name] of nodeFixtures) {
      expect(files.has(`${name}.json`), `${name}.json missing`).toBe(true);
    }
    expect(Object.keys(TRON_NODE_PATHS)).toHaveLength(18);
    expect(Object.keys(TRON_INDEXER_PATHS)).toHaveLength(3);
  });
});
