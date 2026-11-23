import { toEventSelector } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { approvalsResponse } from "@qntx/wallet-engine/gateway/contract";

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
  rpcOk,
} from "./helpers.ts";
import type { UpstreamCall } from "./helpers.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OWNER_TOPIC = `0x${"0".repeat(24)}${OWNER.slice(2).toLowerCase()}`;
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NFT = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const SPENDER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const OPERATOR = "0x1E0049783F008A0085193E00003D00cd54003c71";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const TOPIC_APPROVAL = toEventSelector(
  "Approval(address indexed owner, address indexed spender, uint256 value)",
);
const TOPIC_APPROVAL_FOR_ALL = toEventSelector(
  "ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
);
const TOPIC_PERMIT2_APPROVAL = toEventSelector(
  "Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)",
);
const TOPIC_PERMIT2_PERMIT = toEventSelector(
  "Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)",
);

const ETH = "eip155:1";
const BASE = "eip155:8453";
const SONIC = "eip155:146";
const SEPOLIA = "eip155:11155111";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  { id: ETH, providers: [{ id: "alchemy", url: "https://eth.alchemy.test/v2" }] },
  { id: BASE, providers: [{ id: "alchemy", url: "https://base.alchemy.test/v2" }] },
  { id: SONIC, providers: [{ id: "alchemy", url: "https://sonic.alchemy.test/v2" }] },
  { id: SEPOLIA, providers: [{ id: "other", url: "https://other.test" }] },
  { id: SOLANA, providers: [{ id: "alchemy", url: "https://sol.alchemy.test" }] },
];

const UPSTREAM: Readonly<Record<string, string>> = {
  [ETH]: "https://eth.alchemy.test",
  [BASE]: "https://base.alchemy.test",
  [SONIC]: "https://sonic.alchemy.test",
};

const HEAD = "0x1934953";
const topic = (address: string): string => `0x${"0".repeat(24)}${address.slice(2)}`;
const uintTopic = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

const log = (fields: {
  readonly address: string;
  readonly topics: ReadonlyArray<string>;
  readonly blockNumber?: string;
  readonly removed?: boolean;
}): Record<string, unknown> => ({
  address: fields.address,
  topics: fields.topics,
  blockNumber: fields.blockNumber ?? "0x100",
  transactionHash: `0x${"ab".repeat(32)}`,
  data: "0x",
  logIndex: "0x1",
  transactionIndex: "0x0",
  blockHash: `0x${"cd".repeat(32)}`,
  removed: fields.removed ?? false,
});

const method = (call: UpstreamCall): string =>
  (JSON.parse(call.body) as { method?: string }).method ?? "";
const filter = (call: UpstreamCall): Record<string, unknown> =>
  (JSON.parse(call.body) as { params?: Array<Record<string, unknown>> }).params?.[0] ?? {};

/** Answers eth_blockNumber with `head` and each eth_getLogs by its filter's topic0. */
const upstream = (answers: Partial<Record<string, () => ReadonlyArray<unknown>>>, head = HEAD) => {
  const seen: UpstreamCall[] = [];
  const handler = (call: UpstreamCall): Response => {
    seen.push(call);
    if (method(call) === "eth_blockNumber") {
      return rpcOk(head);
    }
    const { topics } = filter(call);
    const topic0 = Array.isArray(topics) ? String(topics[0]) : "";
    return rpcOk(answers[topic0]?.() ?? []);
  };
  return { handler, seen };
};

const request = (caip2: string, body: unknown) => [`/v1/approvals/${caip2}`, post(body)] as const;

/** Answers eth_blockNumber with HEAD and every eth_getLogs with `answer`. */
const logsAnswer =
  (answer: () => Response) =>
  (call: UpstreamCall): Response =>
    method(call) === "eth_blockNumber" ? rpcOk(HEAD) : answer();

describe("the scanned topic constants", () => {
  it("match viem's event selectors", () => {
    expect(TOPIC_APPROVAL).toBe(
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    );
    expect(TOPIC_APPROVAL_FOR_ALL).toBe(
      "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
    );
    expect(TOPIC_PERMIT2_APPROVAL).toBe(
      "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b",
    );
    expect(TOPIC_PERMIT2_PERMIT).toBe(
      "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec",
    );
  });
});

describe("approval candidates", () => {
  it("reads the head, then scans four filters in parallel", async () => {
    const up = upstream({});
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-providers")).toBe("alchemy-approvals");
    const body = (await expectContract(res, approvalsResponse)) as {
      toBlock: string;
      candidates: ReadonlyArray<unknown>;
      truncated: boolean;
    };
    expect(body.toBlock).toBe("26429779");
    expect(body.candidates).toStrictEqual([]);
    expect(body.truncated).toBe(false);
    expect(up.seen).toHaveLength(5);
    const [headCall, ...logCalls] = up.seen;
    expect(method(headCall!)).toBe("eth_blockNumber");
    expect(logCalls.map(method)).toStrictEqual(Array.from({ length: 4 }, () => "eth_getLogs"));
    const filters = logCalls.map(filter);
    expect(filters[0]).toStrictEqual({
      fromBlock: "0x0",
      toBlock: HEAD,
      topics: [TOPIC_APPROVAL, OWNER_TOPIC],
    });
    expect(filters[1]).toStrictEqual({
      fromBlock: "0x0",
      toBlock: HEAD,
      topics: [TOPIC_APPROVAL_FOR_ALL, OWNER_TOPIC],
    });
    expect(filters[2]).toStrictEqual({
      address: PERMIT2,
      fromBlock: "0x0",
      toBlock: HEAD,
      topics: [TOPIC_PERMIT2_APPROVAL, OWNER_TOPIC],
    });
    expect(filters[3]).toStrictEqual({
      address: PERMIT2,
      fromBlock: "0x0",
      toBlock: HEAD,
      topics: [TOPIC_PERMIT2_PERMIT, OWNER_TOPIC],
    });
  });

  it("maps a 3-topic Approval to erc20 and a 4-topic one to erc721", async () => {
    const up = upstream({
      [TOPIC_APPROVAL]: () => [
        log({ address: TOKEN, topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER)] }),
        log({
          address: NFT,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER), uintTopic(42n)],
          blockNumber: "0x200",
        }),
        // Two indexed arguments plus extra garbage: neither erc20 nor erc721.
        log({
          address: TOKEN,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER), uintTopic(1n), uintTopic(2n)],
        }),
        // A spender topic whose 12 padding bytes are not zero is dropped, not trusted.
        log({
          address: TOKEN,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, `0x01${"0".repeat(62)}`],
        }),
      ],
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    const body = (await expectContract(res, approvalsResponse)) as {
      candidates: Array<Record<string, unknown>>;
    };
    expect(body.candidates).toStrictEqual([
      {
        kind: "erc721",
        token: NFT.toLowerCase(),
        spender: SPENDER.toLowerCase(),
        tokenId: "42",
        block: "512",
      },
      {
        kind: "erc20",
        token: TOKEN.toLowerCase(),
        spender: SPENDER.toLowerCase(),
        block: "256",
      },
    ]);
  });

  it("maps ApprovalForAll to operator and both Permit2 events to permit2", async () => {
    const permit2Log = (topic0: string) =>
      log({
        address: PERMIT2,
        topics: [topic0, OWNER_TOPIC, topic(TOKEN), topic(SPENDER)],
        blockNumber: "0x300",
      });
    const up = upstream({
      [TOPIC_APPROVAL_FOR_ALL]: () => [
        log({
          address: NFT,
          topics: [TOPIC_APPROVAL_FOR_ALL, OWNER_TOPIC, topic(OPERATOR)],
        }),
        // An ApprovalForAll with a fourth topic is not the event the filter names.
        log({
          address: NFT,
          topics: [TOPIC_APPROVAL_FOR_ALL, OWNER_TOPIC, topic(OPERATOR), uintTopic(1n)],
        }),
      ],
      [TOPIC_PERMIT2_APPROVAL]: () => [permit2Log(TOPIC_PERMIT2_APPROVAL)],
      [TOPIC_PERMIT2_PERMIT]: () => [permit2Log(TOPIC_PERMIT2_PERMIT)],
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    const body = (await expectContract(res, approvalsResponse)) as {
      candidates: Array<Record<string, unknown>>;
    };
    expect(body.candidates).toStrictEqual([
      {
        kind: "permit2",
        token: TOKEN.toLowerCase(),
        spender: SPENDER.toLowerCase(),
        block: "768",
      },
      {
        kind: "operator",
        token: NFT.toLowerCase(),
        operator: OPERATOR.toLowerCase(),
        block: "256",
      },
    ]);
  });

  it("dedupes on the approval key, keeping the highest block", async () => {
    const up = upstream({
      [TOPIC_APPROVAL]: () => [
        log({
          address: TOKEN,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER)],
          blockNumber: "0x100",
        }),
        // The same token+spender approved again later — the later event keeps the row.
        log({
          address: TOKEN,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER)],
          blockNumber: "0x400",
        }),
        // ERC-721 dedupes on token+tokenId: a new spender for id 42 supersedes the old row.
        log({
          address: NFT,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(OPERATOR), uintTopic(42n)],
          blockNumber: "0x100",
        }),
        log({
          address: NFT,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER), uintTopic(42n)],
          blockNumber: "0x500",
        }),
      ],
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    const body = (await expectContract(res, approvalsResponse)) as {
      candidates: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    expect(body.candidates).toStrictEqual([
      {
        kind: "erc721",
        token: NFT.toLowerCase(),
        spender: SPENDER.toLowerCase(),
        tokenId: "42",
        block: "1280",
      },
      {
        kind: "erc20",
        token: TOKEN.toLowerCase(),
        spender: SPENDER.toLowerCase(),
        block: "1024",
      },
    ]);
    expect(body.truncated).toBe(false);
  });

  it("drops removed and malformed logs", async () => {
    const up = upstream({
      [TOPIC_APPROVAL]: () => [
        // A reorged-out event would invent a candidate the chain no longer holds.
        log({
          address: TOKEN,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(OPERATOR)],
          blockNumber: "0x900",
          removed: true,
        }),
        log({
          address: TOKEN,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER)],
        }),
        // Malformed shapes: dropped, never thrown.
        "not-a-log",
        { address: TOKEN },
        log({ address: "0xnothex", topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER)] }),
        log({ address: TOKEN, topics: [TOPIC_APPROVAL, OWNER_TOPIC, "0xshort"] }),
        log({ address: TOKEN, topics: [] }),
        log({
          address: TOKEN,
          topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER)],
          blockNumber: "nope",
        }),
      ],
    });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    const body = (await expectContract(res, approvalsResponse)) as {
      candidates: Array<Record<string, unknown>>;
    };
    expect(body.candidates).toStrictEqual([
      {
        kind: "erc20",
        token: TOKEN.toLowerCase(),
        spender: SPENDER.toLowerCase(),
        block: "256",
      },
    ]);
  });

  it("caps the list at 500 and flags the answer truncated", async () => {
    const many = Array.from({ length: 501 }, (_v, i) =>
      log({
        address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
        topics: [TOPIC_APPROVAL, OWNER_TOPIC, topic(SPENDER)],
        blockNumber: `0x${(i + 1).toString(16)}`,
      }),
    );
    const up = upstream({ [TOPIC_APPROVAL]: () => many });
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    const body = (await expectContract(res, approvalsResponse)) as {
      candidates: Array<{ block: string }>;
      truncated: boolean;
    };
    expect(body.candidates).toHaveLength(500);
    expect(body.candidates[0]?.block).toBe("501");
    expect(body.truncated).toBe(true);
  });

  it("404s unsupported on a range-bounded chain and an absent provider, without a call", async () => {
    const fetch = fakeFetch({});
    const app = gateway({ fetch: fetch.fetch, networks: NETWORKS });
    // Sonic's Alchemy range is 10,000 blocks — the scan would be silently incomplete.
    const sonic = await app.request(...request(SONIC, { address: OWNER }));
    expect(sonic.status).toBe(404);
    await expect(sonic.json()).resolves.toMatchObject({ error: "unsupported" });
    const sepolia = await app.request(...request(SEPOLIA, { address: OWNER }));
    expect(sepolia.status).toBe(404);
    const solana = await app.request(...request(SOLANA, { address: OWNER }));
    expect(solana.status).toBe(404);
    await expect(solana.json()).resolves.toMatchObject({ error: "unknown-network" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects malformed bodies and answers a bad address nothing upstream", async () => {
    const fetch = fakeFetch({});
    const app = gateway({ fetch: fetch.fetch, networks: NETWORKS });
    const bad: ReadonlyArray<unknown> = [
      {},
      { address: "not-an-address" },
      { address: OWNER.slice(2) },
      { address: OWNER, extra: 1 },
      "not-an-object",
    ];
    await Promise.all(
      bad.map(async (body) => {
        const res = await app.request(...request(ETH, body));
        expect(res.status).toBe(400);
      }),
    );
    const get = await app.request(`/v1/approvals/${ETH}`, { method: "GET", headers: headers() });
    expect(get.status).toBe(404);
    expect(fetch.calls).toHaveLength(0);
  });

  it("maps an upstream JSON-RPC error to 503", async () => {
    const up = {
      handler: logsAnswer(() =>
        Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }),
      ),
      seen: [] as UpstreamCall[],
    };
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(503);
  });

  it("maps a malformed or refused upstream answer to 503, a 400 to the caller's 400", async () => {
    const malformed = {
      handler: logsAnswer(() => rpcOk({ notLogs: true })),
      seen: [] as UpstreamCall[],
    };
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: malformed.handler }).fetch,
      networks: NETWORKS,
    });
    const malformedRes = await app.request(...request(ETH, { address: OWNER }));
    expect(malformedRes.status).toBe(503);
    const refused = gateway({
      fetch: fakeFetch({
        [UPSTREAM[ETH]!]: () => new Response("no", { status: 429 }),
      }).fetch,
      networks: NETWORKS,
    });
    const refusedRes = await refused.request(...request(ETH, { address: OWNER }));
    expect(refusedRes.status).toBe(503);
    const badFilter = gateway({
      fetch: fakeFetch({
        [UPSTREAM[ETH]!]: () => new Response('{"error":"bad filter"}', { status: 400 }),
      }).fetch,
      networks: NETWORKS,
    });
    const badFilterRes = await badFilter.request(...request(ETH, { address: OWNER }));
    expect(badFilterRes.status).toBe(400);
  });

  it("answers an oversized upstream body with the caller's 400", async () => {
    const up = {
      handler: logsAnswer(
        () => new Response("x", { headers: { "content-length": String(9 * 1024 * 1024) } }),
      ),
      seen: [] as UpstreamCall[],
    };
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
  });

  it("bills one blockNumber and four getLogs calls by their compute cost", async () => {
    const limiter = recordingLimiter();
    const up = upstream({});
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: limiter },
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(200);
    // eth_blockNumber 10 CU → 1 share unit; eth_getLogs 60 CU → 2 each.
    expect(limiter.deltas).toStrictEqual([1, 2, 2, 2, 2]);
    expect(limiter.keys).toStrictEqual(Array.from({ length: 5 }, () => "alchemy:unknown"));
  });

  it("a refused share charge stops the run before the getLogs round", async () => {
    const up = upstream({});
    const app = gateway({
      fetch: fakeFetch({ [UPSTREAM[ETH]!]: up.handler }).fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: countBefore(1) },
    });
    const res = await app.request(...request(ETH, { address: OWNER }));
    expect(res.status).toBe(429);
    expect(up.seen).toHaveLength(1);
    expect(method(up.seen[0]!)).toBe("eth_blockNumber");
  });
});
