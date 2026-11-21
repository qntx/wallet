import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { historyResponse } from "@qntx/wallet-engine/gateway/contract";

import type { GatewayNetwork } from "../src/types.ts";
import {
  allowAll,
  countBefore,
  expectContract,
  fakeFetch,
  gateway,
  headers,
  post,
  recordingLimiter,
} from "./helpers.ts";
import type { UpstreamCall } from "./helpers.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ETH = "eip155:1";
const ARB = "eip155:42161";
const HYPE = "eip155:999";
const ARC = "eip155:5042";
const SONIC = "eip155:146";
const SEPOLIA = "eip155:11155111";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  { id: ETH, providers: [{ id: "alchemy", url: "https://eth.alchemy.test/v2" }] },
  { id: ARB, providers: [{ id: "alchemy", url: "https://arb.alchemy.test/v2" }] },
  { id: HYPE, providers: [{ id: "alchemy", url: "https://hype.alchemy.test/v2" }] },
  { id: ARC, providers: [{ id: "alchemy", url: "https://arc.alchemy.test/v2" }] },
  { id: SONIC, providers: [{ id: "alchemy", url: "https://sonic.alchemy.test/v2" }] },
  { id: SEPOLIA, providers: [{ id: "other", url: "https://other.test" }] },
  { id: SOLANA, providers: [{ id: "alchemy", url: "https://sol.alchemy.test" }] },
];

const UPSTREAM: Readonly<Record<string, string>> = {
  [ETH]: "https://eth.alchemy.test",
  [ARB]: "https://arb.alchemy.test",
  [HYPE]: "https://hype.alchemy.test",
  [ARC]: "https://arc.alchemy.test",
  [SONIC]: "https://sonic.alchemy.test",
};

type Fixture = { readonly response: unknown };

const fixture = (name: string): Fixture =>
  JSON.parse(
    readFileSync(
      new URL(`fixtures/alchemy-transfers/${name}.json`, import.meta.url).pathname,
      "utf8",
    ),
  ) as Fixture;

type TransfersPage = {
  readonly transfers: ReadonlyArray<Record<string, unknown>>;
  readonly pageKey?: string;
};

const page = (body: unknown): TransfersPage => {
  const { result } = body as { result?: TransfersPage };
  if (result === undefined) {
    throw new Error("fixture is not a transfers page");
  }
  return result;
};

const firstRoundKeyed = (round: number, transfers: ReadonlyArray<Record<string, unknown>>) =>
  round === 1 ? { transfers, pageKey: "k" } : { transfers };

const params = (call: UpstreamCall): Record<string, unknown> => {
  const parsed = JSON.parse(call.body) as { params?: Array<Record<string, unknown>> };
  const first = parsed.params?.[0];
  if (first === undefined) {
    throw new Error(`upstream call carries no params: ${call.body}`);
  }
  return first;
};

/** Answers `alchemy_getAssetTransfers` by direction; `answer` may swap per round. */
const upstream = (answers: { readonly to?: () => unknown; readonly from?: () => unknown }) => {
  const seen: UpstreamCall[] = [];
  const handler = (call: UpstreamCall): Response => {
    seen.push(call);
    const p = params(call);
    const result =
      "toAddress" in p
        ? answers.to === undefined
          ? { transfers: [] }
          : answers.to()
        : answers.from === undefined
          ? { transfers: [] }
          : answers.from();
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
  return { handler, seen };
};

const request = (caip2: string, body: unknown) => [`/v1/history/${caip2}`, post(body)] as const;

describe("history page", () => {
  it("merges both directions and withholds the frontier block", async () => {
    const up = upstream({
      to: () => page(fixture("eth-to").response),
      from: () => page(fixture("eth-from").response),
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-providers")).toBe("alchemy-transfers");
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{
        hash: string;
        block: string;
        timestamp: number;
        transfers: Array<Record<string, unknown>>;
      }>;
      cursor: string | null;
      truncated: boolean;
    };
    expect(body.cursor).toBe("26429715");
    expect(body.truncated).toBe(false);
    expect(body.items.map((i) => i.hash)).toStrictEqual([
      "0xda98151f32d7fb8c8daad5849363590ca179c6511b3f7d7e6d613d50072b0533",
      "0x979e19a53feb2c15122009b523c48f66df025de6ff54db5290c567eac324f181",
      "0x766f83db9c611cbff14150daaea08a2b1570c7bfe8c875dc60c6aaaaf6b5be46",
    ]);
    const [native, erc20] = body.items;
    expect(native?.block).toBe("26440576");
    expect(native?.timestamp).toBe(Date.parse("2026-11-18T07:54:23.000Z"));
    expect(native?.transfers[0]).toMatchObject({
      kind: "native",
      from: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
      to: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      contract: null,
      tokenId: null,
      amount: "0",
      decimals: 18,
      symbol: "ETH",
      logIndex: null,
    });
    expect(erc20?.transfers[0]).toMatchObject({
      kind: "erc20",
      from: "0xd152f549545093347a162dce210e7293f1452150",
      contract: "0x72e4f9f808c49a2a61de9c5896298920dc4eeea9",
      amount: "923842391",
      decimals: 8,
      symbol: "BITCOIN",
      logIndex: 1000,
    });
    // Both upstream calls ran in parallel, newest-first, full category list for mainnet.
    expect(up.seen).toHaveLength(2);
    for (const call of up.seen) {
      const p = params(call);
      expect(p["fromBlock"]).toBe("0x0");
      expect(p["toBlock"]).toBe("latest");
      expect(p["order"]).toBe("desc");
      expect(p["maxCount"]).toBe("0x32");
      expect(p["category"]).toStrictEqual(["external", "internal", "erc20", "erc721", "erc1155"]);
    }
  });

  it("pages backwards with the frontier as inclusive bound", async () => {
    const up = upstream({
      to: () => page(fixture("eth-to-page2").response),
      from: () => ({ transfers: [] }),
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER, cursor: "26429715" }));
    expect(res.status).toBe(200);
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ hash: string }>;
      cursor: string | null;
    };
    for (const call of up.seen) {
      expect(params(call)["toBlock"]).toBe("0x1934913");
    }
    expect(body.items.map((i) => i.hash)).toStrictEqual([
      "0x4425a37a64f83e4b326e0119542855e5244e85f75f44bbce9c3f4cfed27372aa",
      "0x775c13156d292b53332344b264ae7665a7bb682295caffd40070a91f934f5715",
      "0x4df907bf856fc9f094f611eb17492a9de285305beb61cc00431b26eeea348b82",
    ]);
    expect(body.cursor).toBe("26426437");
  });

  it("drains a frontier block that yields nothing else", async () => {
    let round = 0;
    const up = upstream({
      to: () => {
        round += 1;
        const { transfers } = page(fixture("eth-to").response);
        const pair = transfers.filter((t) => t["hash"]?.toString().startsWith("0x865952a5"));
        return firstRoundKeyed(round, pair);
      },
      from: () => ({ transfers: [] }),
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ hash: string; block: string }>;
      cursor: string | null;
      truncated: boolean;
    };
    const drain = up.seen.slice(2);
    expect(drain).toHaveLength(2);
    for (const call of drain) {
      const p = params(call);
      expect(p["fromBlock"]).toBe("0x1934913");
      expect(p["toBlock"]).toBe("0x1934913");
      expect(p["maxCount"]).toBe("0x3e8");
    }
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.hash).toBe(
      "0x865952a53a753b3900906186fe6e24c19a1af6ab14f389575b390c6b5c03d92c",
    );
    expect(body.cursor).toBe("26429714");
    // The drain round came back unkeyed — the whole block fit, no gap to report.
    expect(body.truncated).toBe(false);
  });

  it("flags a drained frontier block that still does not fit one max page", async () => {
    let round = 0;
    const up = upstream({
      to: () => {
        round += 1;
        const { transfers } = page(fixture("eth-to").response);
        const pair = transfers.filter((t) => t["hash"]?.toString().startsWith("0x865952a5"));
        // Every round answers keyed — the drain round's pageKey means the block is still split.
        return { transfers: pair, pageKey: "k" };
      },
      from: () => ({ transfers: [] }),
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ hash: string; transfers: ReadonlyArray<unknown> }>;
      cursor: string | null;
      truncated: boolean;
    };
    expect(round).toBe(2);
    // The drained transfers are kept; the cursor still walks past the block.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.transfers).toHaveLength(2);
    expect(body.cursor).toBe("26429714");
    expect(body.truncated).toBe(true);
  });

  it("returns cursor null and dedupes a self-transfer when nothing pages", async () => {
    const selfTransfer = {
      ...page(fixture("eth-to").response).transfers[0],
      from: OWNER.toLowerCase(),
      uniqueId: "0xself:external",
    };
    const body1 = { transfers: [selfTransfer] };
    const body2 = { transfers: [selfTransfer] };
    const up = upstream({ to: () => body1, from: () => body2 });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ transfers: ReadonlyArray<unknown> }>;
      cursor: string | null;
    };
    expect(body.cursor).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.transfers).toHaveLength(1);
  });

  it("orders an item's erc721 transfers by logIndex", async () => {
    const { transfers, pageKey } = page(fixture("eth-to").response);
    expect(pageKey).toBeDefined();
    const up = upstream({
      to: () => ({
        transfers: transfers.filter((t) => t["hash"]?.toString().startsWith("0x865952a5")),
      }),
      from: () => ({ transfers: [] }),
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ transfers: Array<{ tokenId: string; logIndex: number }> }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.transfers.map((t) => t.tokenId)).toStrictEqual(["109", "110"]);
    expect(body.items[0]?.transfers.map((t) => t.logIndex)).toStrictEqual([628, 629]);
  });

  it("omits the internal category on chains that do not support it", async () => {
    const up = upstream({ to: () => ({ transfers: [] }), from: () => ({ transfers: [] }) });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ARB]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ARB, { address: OWNER }));
    expect(res.status).toBe(200);
    for (const call of up.seen) {
      expect(params(call)["category"]).toStrictEqual(["external", "erc20", "erc721", "erc1155"]);
    }
  });

  it("includes the internal category on Arc", async () => {
    const up = upstream({ to: () => ({ transfers: [] }), from: () => ({ transfers: [] }) });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ARC]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ARC, { address: OWNER }));
    expect(res.status).toBe(200);
    for (const call of up.seen) {
      expect(params(call)["category"]).toStrictEqual([
        "external",
        "internal",
        "erc20",
        "erc721",
        "erc1155",
      ]);
    }
  });

  it("404s unsupported for a served network with no history provider, without an upstream call", async () => {
    const fetch = fakeFetch({});
    const app = gateway({ fetch: fetch.fetch, networks: NETWORKS });
    const res = await app.request(...request(SONIC, { address: OWNER }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "unsupported" });
    expect(res.headers.get("retry-after")).toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it("maps the hyperevm fixture: one erc20 and two natives", async () => {
    const up = upstream({
      to: () => page(fixture("hyperevm-to").response),
      from: () => ({ transfers: [] }),
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[HYPE]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(HYPE, { address: OWNER }));
    expect(res.status).toBe(200);
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ hash: string; transfers: Array<Record<string, unknown>> }>;
      cursor: string | null;
    };
    // pageKey present → the lowest block 0x2c94a46 is withheld, two items survive.
    expect(body.items.map((i) => i.hash)).toStrictEqual([
      "0x97fbbde0cd1b97148e0c9a4d295ba1e48b699a589c130d956fd5542c2ce5b15d",
      "0x58fa7c5b8c411e92c7844170168d1b6d8ea84e2fc086ee774e35ebd318e314d3",
    ]);
    expect(body.items[0]?.transfers[0]).toMatchObject({
      kind: "erc20",
      from: "0x9845636fd55f620d18a2c7fd3e4e6bd8e4de173d",
      contract: "0xcb75708e3d2cb29c6c1ce174909c5fbf388fd2ea",
      amount: "108131487889273",
      decimals: 18,
      logIndex: 59,
    });
    expect(body.items[1]?.transfers[0]).toMatchObject({
      kind: "native",
      from: "0x984573e30a7db8575ba4d71c4af59d22933e173d",
      amount: "108131487889273",
    });
  });

  it("maps an upstream JSON-RPC error to 503", async () => {
    const up = {
      handler: (): Response => Response.json(fixture("arb-internal-error").response),
      seen: [] as UpstreamCall[],
    };
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ARB]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ARB, { address: OWNER }));
    expect(res.status).toBe(503);
  });

  it("rejects malformed requests and unsupported routes", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch, networks: NETWORKS });
    const bad: ReadonlyArray<unknown> = [
      { address: "not-an-address" },
      { address: OWNER, extra: 1 },
      { address: OWNER, limit: 51 },
      { address: OWNER, cursor: "01" },
      { address: OWNER, cursor: "0x10" },
      { address: OWNER, cursor: "-1" },
      { address: OWNER, cursor: "1.5" },
    ];
    await Promise.all(
      bad.map(async (body) => {
        const res = await app.request(...request(ETH, body));
        expect(res.status).toBe(400);
      }),
    );
    const solana = await app.request(...request(SOLANA, { address: OWNER }));
    expect(solana.status).toBe(404);
    const sepolia = await app.request(...request(SEPOLIA, { address: OWNER }));
    expect(sepolia.status).toBe(404);
    await expect(sepolia.json()).resolves.toMatchObject({ error: "unsupported" });
    const get = await app.request(`/v1/history/${ETH}`, { method: "GET", headers: headers() });
    expect(get.status).toBe(404);
  });

  it("maps malformed and refused upstream answers to 503", async () => {
    const malformed = upstream({ to: () => "not-a-page", from: () => ({ transfers: [] }) });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: malformed.handler }).fetch,
      networks: NETWORKS,
    });
    const upstreamDown = await app.request(...request(ETH, { address: OWNER }));
    expect(upstreamDown.status).toBe(503);
    const refused = {
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: () => new Response("no", { status: 429 }) }).fetch,
    };
    const app2 = gateway({ ...refused, networks: NETWORKS });
    const rateLimited = await app2.request(...request(ETH, { address: OWNER }));
    expect(rateLimited.status).toBe(503);
  });

  it("cuts an item's transfers at 100", async () => {
    const { transfers } = page(fixture("eth-to").response);
    const one = transfers.find((t) => t["category"] === "erc20");
    const many = Array.from({ length: 101 }, (_, i) => ({
      ...one,
      uniqueId: `0xmany:log:${i}`,
    }));
    const up = upstream({ to: () => ({ transfers: many }), from: () => ({ transfers: [] }) });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ transfers: ReadonlyArray<unknown> }>;
      truncated: boolean;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.transfers).toHaveLength(100);
    expect(body.truncated).toBe(true);
  });

  it("flags and cuts a page over 500 items", async () => {
    const { transfers } = page(fixture("eth-to").response);
    const one = transfers.find((t) => t["category"] === "erc20");
    const many = Array.from({ length: 501 }, (_, i) => ({
      ...one,
      uniqueId: `0xitems:${i}`,
      hash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
    }));
    const up = upstream({ to: () => ({ transfers: many }), from: () => ({ transfers: [] }) });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    const body = (await expectContract(res, historyResponse)) as {
      items: Array<{ hash: string }>;
      truncated: boolean;
    };
    expect(body.items).toHaveLength(500);
    expect(body.truncated).toBe(true);
  });

  it("a refused share charge never reaches the upstream drain calls", async () => {
    // Two calls' deltas (3 share units per 120-CU transfers call) fit; the drain's do not.
    const keyed = {
      transfers: page(fixture("eth-to").response).transfers.slice(0, 1),
      pageKey: "k",
    };
    const up = upstream({ to: () => keyed, from: () => ({ transfers: [] }) });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: countBefore(6) },
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(429);
    expect(up.seen).toHaveLength(2);
  });

  it("charges a drained page two units more, before the drain round", async () => {
    const limiter = recordingLimiter();
    let round = 0;
    const up = upstream({
      to: () => {
        round += 1;
        return firstRoundKeyed(round, page(fixture("eth-to").response).transfers.slice(0, 1));
      },
      from: () => ({ transfers: [] }),
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: limiter },
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    expect(up.seen).toHaveLength(4);
    // Four `alchemy_getAssetTransfers` calls at 120 CU each, billed 3 share units a call.
    expect(limiter.deltas).toStrictEqual([3, 3, 3, 3]);
    expect(limiter.keys).toStrictEqual(Array.from({ length: 4 }, () => "alchemy:unknown"));
  });

  it("bills a plain page's two upstream calls by their compute cost", async () => {
    const limiter = recordingLimiter();
    const up = upstream({ to: () => ({ transfers: [] }), from: () => ({ transfers: [] }) });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: limiter },
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    expect(limiter.deltas).toStrictEqual([3, 3]);
  });
});
