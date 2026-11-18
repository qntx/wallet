import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  gatewayError,
  health,
  rpcResponse,
  servedNetworksResponse,
} from "@qntx/wallet-engine/gateway/contract";

import { ipPrefix } from "../src/middleware/rate-limit.ts";
import type { RateLimiter } from "../src/types.ts";
import {
  DEVNET,
  CLIENT_ID,
  MAINNET_BITCOIN,
  ORIGIN,
  SEPOLIA,
  SIGNET,
  allowAll,
  call,
  countBefore,
  denyAll,
  expectContract,
  fakeFetch,
  gateway,
  headers,
  post,
  recordingLimiter,
  rpcFailure,
  rpcOk,
} from "./helpers.ts";
import type { Upstream } from "./helpers.ts";

const HASH = "ab".repeat(32);

/** Answers `eth_getLogs` calls from `answer`; every other call gets a canned chain id. */
const onlyLogsCalls =
  (answer: () => Response): Upstream =>
  (call) =>
    call.body.includes("eth_getLogs") ? answer() : rpcOk("0xaa36a7");

/** A batch of `eth_getLogs` at every filter bound — the maximum cost one request can carry. */
const maxCostLogsBatch = () =>
  Array.from({ length: 20 }, (_v, i) =>
    call(
      "eth_getLogs",
      [
        {
          fromBlock: "0x1",
          toBlock: "0x1f4",
          address: Array.from(
            { length: 20 },
            (_a, j) => `0x${(i * 20 + j).toString(16).padStart(40, "0")}`,
          ),
          topics: [Array.from({ length: 20 }, (_t, k) => `0x${k.toString(16).padStart(64, "0")}`)],
        },
      ],
      i,
    ),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("health and identity", () => {
  it("serves health without an client id and matches the contract", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch });
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    await expectContract(res, health.response);
  });

  it.each([
    ["missing", {}],
    ["too short", { "x-client-id": "abcd" }],
    ["uppercase", { "x-client-id": CLIENT_ID.toUpperCase() }],
    ["not hex", { "x-client-id": "z".repeat(32) }],
  ])("rejects a %s client id with 400", async (_name, h) => {
    const upstream = fakeFetch({});
    const app = gateway({ fetch: upstream.fetch });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify(call("eth_chainId")),
    });
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(upstream.calls).toHaveLength(0);
  });

  it("answers unknown paths with a contract 404", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch });
    const res = await app.request("/v1/nope", { headers: headers() });
    expect(res.status).toBe(404);
    await expectContract(res, gatewayError);
  });
});

describe("served networks", () => {
  it("lists the configured networks in order and matches the contract", async () => {
    const res = await gateway({ fetch: fakeFetch({}).fetch }).request("/v1/networks", {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    await expect(expectContract(res, servedNetworksResponse)).resolves.toStrictEqual({
      networks: [SEPOLIA, DEVNET, SIGNET],
    });
  });

  it("requires an client id and counts against the default limiter", async () => {
    const rpc = recordingLimiter();
    const dflt = recordingLimiter();
    const app = gateway({
      fetch: fakeFetch({}).fetch,
      limiters: { ip: allowAll, rpc, default: dflt },
    });
    const anonymous = await app.request("/v1/networks");
    const identified = await app.request("/v1/networks", { headers: headers() });
    expect(anonymous.status).toBe(400);
    expect(identified.status).toBe(200);
    expect(dflt.keys).toHaveLength(1);
    expect(rpc.keys).toHaveLength(0);
  });

  it("answers 429 when the default limiter refuses", async () => {
    const app = gateway({
      fetch: fakeFetch({}).fetch,
      limiters: { ip: allowAll, rpc: denyAll, default: denyAll },
    });
    const res = await app.request("/v1/networks", { headers: headers() });
    expect(res.status).toBe(429);
  });
});

describe("rpc validation", () => {
  const upstream = () => fakeFetch({ "https://a.test/evm": () => rpcOk("0xaa36a7") });

  it.each(["eip155:999999", MAINNET_BITCOIN, SIGNET, "garbage"])(
    "404s %s on the rpc route",
    async (id) => {
      const up = upstream();
      const res = await gateway({ fetch: up.fetch }).request(
        `/v1/rpc/${id}`,
        post(call("eth_chainId")),
      );
      expect(res.status).toBe(404);
      await expectContract(res, gatewayError);
      expect(up.calls).toHaveLength(0);
    },
  );

  it("404s an evm network on the esplora route", async () => {
    const up = upstream();
    const app = gateway({ fetch: up.fetch });
    const esplora = await app.request(`/v1/esplora/${SEPOLIA}/fee-estimates`, {
      headers: headers(),
    });
    expect(esplora.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
    ["an empty batch", JSON.stringify([])],
    ["a non-call object", JSON.stringify({ hello: 1 })],
    ["a batch of 21", Array.from({ length: 21 }, (_v, i) => call("eth_chainId", [], i))],
  ])("400s %s", async (_name, body) => {
    const up = upstream();
    const res = await gateway({ fetch: up.fetch }).request(`/v1/rpc/${SEPOLIA}`, post(body));
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it("413s an rpc body above 512 KiB without reading it upstream", async () => {
    const up = upstream();
    const big = JSON.stringify(call("eth_call", [{ data: `0x${"00".repeat(300 * 1024)}` }]));
    const res = await gateway({ fetch: up.fetch }).request(`/v1/rpc/${SEPOLIA}`, post(big));
    expect(res.status).toBe(413);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it("413s an esplora body above 1 MB", async () => {
    const up = fakeFetch({});
    const res = await gateway({ fetch: up.fetch }).request(`/v1/esplora/${SIGNET}/tx`, {
      method: "POST",
      headers: headers(),
      body: "00".repeat(600_000),
    });
    expect(res.status).toBe(413);
    expect(up.calls).toHaveLength(0);
  });

  it("accepts a batch of exactly 20", async () => {
    const app = gateway({
      fetch: fakeFetch({
        "https://a.test/evm": () =>
          Response.json(
            Array.from({ length: 20 }, (_v, i) => ({ jsonrpc: "2.0", id: i, result: "0x1" })),
          ),
      }).fetch,
    });
    const batch20 = Array.from({ length: 20 }, (_v, i) => call("eth_chainId", [], i));
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(batch20));
    expect(res.status).toBe(200);
    await expectContract(res, rpcResponse);
  });

  it.each([
    ["a null id", JSON.stringify({ jsonrpc: "2.0", id: null, method: "eth_chainId" })],
    ["a fractional id", JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "eth_chainId" })],
    [
      "a malformed address",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: ["0xzz", "latest"],
      }),
    ],
    [
      "a wrong arity",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [] }),
    ],
  ])("400s %s without calling upstream", async (_name, body) => {
    const up = upstream();
    const res = await gateway({ fetch: up.fetch }).request(`/v1/rpc/${SEPOLIA}`, post(body));
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it.each([
    "eth_sign",
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_sendTransaction",
    "admin_peers",
    "debug_traceCall",
    "eth_getLogs",
  ])("rejects %s", async (method) => {
    const up = upstream();
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call(method)),
    );
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it("rejects the whole batch when one method is forbidden", async () => {
    const up = upstream();
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post([call("eth_chainId", [], 1), call("eth_sign", [], 2)]),
    );
    expect(res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("applies the solana list to solana networks", async () => {
    const up = fakeFetch({ "https://a.test/sol": () => rpcOk("EtWT") });
    const app = gateway({ fetch: up.fetch });
    const ok = await app.request(`/v1/rpc/${DEVNET}`, post(call("getGenesisHash")));
    expect(ok.status).toBe(200);
    const evmMethod = await app.request(`/v1/rpc/${DEVNET}`, post(call("eth_chainId")));
    expect(evmMethod.status).toBe(400);
    const unbounded = await app.request(`/v1/rpc/${DEVNET}`, post(call("getProgramAccounts")));
    expect(unbounded.status).toBe(400);
    expect(up.calls).toHaveLength(1);
  });
});

describe("rpc forwarding", () => {
  it("serves from the first provider and names it", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk("0xaa36a7"),
      "https://b.test/evm": () => rpcOk("0xbad"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
    await expect(expectContract(res, rpcResponse)).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      result: "0xaa36a7",
    });
    expect(up.calls).toHaveLength(1);
    expect(up.calls.map((c) => JSON.parse(c.body))).toStrictEqual([call("eth_chainId")]);
  });

  it("switches to the second provider on 5xx", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("down", { status: 502 }),
      "https://b.test/evm": () => rpcOk("0xaa36a7"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    await expectContract(res, rpcResponse);
    expect(up.callsTo("https://a.test")).toHaveLength(1);
  });

  it("switches on a transport error and on a malformed body", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => {
        throw new TypeError("connection reset");
      },
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const app = gateway({ fetch: up.fetch });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");

    const html = fakeFetch({
      "https://a.test/evm": () => new Response("<html>", { status: 200 }),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const res2 = await gateway({ fetch: html.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    expect(res2.headers.get(PROVIDERS_HEADER)).toBe("b");
  });

  it("switches after the 10 s upstream timeout", async () => {
    vi.useFakeTimers();
    const up = fakeFetch({
      "https://a.test/evm": async (_c, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const pending = gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
  });

  it("returns a JSON-RPC error as-is without switching", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => rpcFailure(-32000, "execution reverted"),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_call", [{ to: `0x${"11".repeat(20)}` }])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
    await expect(expectContract(res, rpcResponse)).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "execution reverted" },
    });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("forwards a bounded eth_getLogs", async () => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const filter = { address: `0x${"11".repeat(20)}`, fromBlock: "0x10", toBlock: "0x20" };
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_getLogs", [filter])),
    );
    expect(res.status).toBe(200);
    expect(up.calls.map((sent) => JSON.parse(sent.body) as unknown)).toMatchObject([
      { params: [filter] },
    ]);
  });

  it.each([
    ["latest to pending", { fromBlock: "latest", toBlock: "pending" }],
    ["pending to latest", { fromBlock: "pending", toBlock: "latest" }],
    ["finalized to finalized", { fromBlock: "finalized", toBlock: "finalized" }],
    ["safe to safe", { fromBlock: "safe", toBlock: "safe" }],
    ["an omitted end", { toBlock: "latest" }],
    ["an omitted start", { fromBlock: "latest" }],
  ])("forwards eth_getLogs over %s", async (_name, filter) => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_getLogs", [filter])),
    );
    expect(res.status).toBe(200);
    expect(up.calls.map((sent) => JSON.parse(sent.body) as unknown)).toMatchObject([
      { params: [filter] },
    ]);
  });

  it.each([
    ["the whole chain", { fromBlock: "earliest", toBlock: "latest" }],
    ["finalized to latest", { fromBlock: "finalized", toBlock: "latest" }],
    ["safe to pending", { fromBlock: "safe", toBlock: "pending" }],
    ["safe to latest", { fromBlock: "safe", toBlock: "latest" }],
    ["pending to finalized", { fromBlock: "pending", toBlock: "finalized" }],
    ["an open-ended range", { fromBlock: "0x10" }],
    ["a range above the limit", { fromBlock: "0x0", toBlock: "0x1f4" }],
    ["too many addresses", { address: Array.from({ length: 21 }, () => `0x${"11".repeat(20)}`) }],
  ])("rejects eth_getLogs over %s without calling upstream", async (_name, filter) => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const app = gateway({ fetch: up.fetch });
    const single = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_getLogs", [filter])));
    expect(single.status).toBe(400);
    await expectContract(single, gatewayError);
    const batch = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post([call("eth_blockNumber"), call("eth_getLogs", [filter], 2)]),
    );
    expect(batch.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("forwards eth_simulateV1 as a read", async () => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_simulateV1", [{ blockStateCalls: [] }, "latest"])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
  });

  it("forwards eth_sendRawTransaction to the first provider", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk(`0x${HASH}`),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", ["0x02"])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
    await expect(res.json()).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      result: `0x${HASH}`,
    });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it.each([400, 413, 422])(
    "answers a request-caused upstream %i with 400, never retries and never trips the breaker",
    async (status) => {
      const up = fakeFetch({
        "https://a.test/evm": onlyLogsCalls(() => new Response("x", { status })),
        "https://b.test/evm": onlyLogsCalls(() => rpcOk([])),
      });
      const app = gateway({ fetch: up.fetch });
      const attackerPost = {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          "x-client-id": "f".repeat(32),
        }),
        body: JSON.stringify(call("eth_getLogs", [{ blockHash: `0x${HASH}` }])),
      } as const;
      const refused = await Promise.all(
        Array.from({ length: 5 }, async () => app.request(`/v1/rpc/${SEPOLIA}`, attackerPost)),
      );
      expect(refused.map((res) => res.status)).toStrictEqual([400, 400, 400, 400, 400]);
      const bodies = await Promise.all(refused.map(async (res) => res.json()));
      expect(bodies).toStrictEqual(Array.from({ length: 5 }, () => ({ error: "invalid-request" })));
      expect(up.callsTo("https://a.test")).toHaveLength(5);
      expect(up.callsTo("https://b.test")).toHaveLength(0);

      const victim = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
      expect(victim.status).toBe(200);
      expect(victim.headers.get(PROVIDERS_HEADER)).toBe("a");
    },
  );

  it.each([404, 429, 500, 502])(
    "upstream %i stays a provider failure: failover, and the shared breaker opens after 5",
    async (status) => {
      const up = fakeFetch({
        "https://a.test/evm": onlyLogsCalls(() => new Response("x", { status })),
        "https://b.test/evm": onlyLogsCalls(() => new Response("x", { status })),
      });
      const app = gateway({ fetch: up.fetch });
      const attackerPost = {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          "x-client-id": "f".repeat(32),
        }),
        body: JSON.stringify(call("eth_getLogs", [{ blockHash: `0x${HASH}` }])),
      } as const;
      const refused = await Promise.all(
        Array.from({ length: 5 }, async () => app.request(`/v1/rpc/${SEPOLIA}`, attackerPost)),
      );
      expect(refused.map((res) => res.status)).toStrictEqual([503, 503, 503, 503, 503]);

      const callsBeforeVictim = up.calls.length;
      const victim = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
      expect(victim.status).toBe(503);
      await expect(victim.json()).resolves.toStrictEqual({ error: "unavailable" });
      expect(victim.headers.get("retry-after")).toBe("30");
      expect(up.calls).toHaveLength(callsBeforeVictim);
    },
  );

  it("opens a provider's breaker after 5 consecutive failures and skips it", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 500 }),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const app = gateway({ fetch: up.fetch });
    const first = await Promise.all(
      Array.from({ length: 5 }, async () =>
        app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId"))),
      ),
    );
    expect(first.map((res) => res.headers.get(PROVIDERS_HEADER))).toStrictEqual([
      "b",
      "b",
      "b",
      "b",
      "b",
    ]);
    expect(up.callsTo("https://a.test")).toHaveLength(5);
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    expect(up.callsTo("https://a.test")).toHaveLength(5);
    expect(up.callsTo("https://b.test")).toHaveLength(6);
  });

  it("answers 503 with Retry-After when every provider fails", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 500 }),
      "https://b.test/evm": () => new Response("", { status: 500 }),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    await expect(expectContract(res, gatewayError)).resolves.toStrictEqual({
      error: "unavailable",
    });
  });
});

describe("broadcasts", () => {
  const RAW_TX = `0x02${"ab".repeat(64)}`;

  it("answers outcome-unknown when the provider may have relayed the transaction", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("bad gateway", { status: 502 }),
      "https://b.test/evm": () => rpcFailure(-32000, "already known"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", [RAW_TX])),
    );
    expect(res.status).toBe(502);
    await expect(expectContract(res, gatewayError)).resolves.toStrictEqual({
      error: "outcome-unknown",
    });
    expect(res.headers.get("retry-after")).toBeNull();
    expect(up.callsTo("https://a.test")).toHaveLength(1);
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("answers outcome-unknown when a broadcast attempt hangs past the upstream timeout", async () => {
    vi.useFakeTimers();
    const up = fakeFetch({
      "https://a.test/evm": async (_c, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      "https://b.test/evm": () => rpcFailure(-32000, "already known"),
    });
    const pending = gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", [RAW_TX])),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toStrictEqual({ error: "outcome-unknown" });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("fails a broadcast over when the provider provably refused the call", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("slow down", { status: 429 }),
      "https://b.test/evm": () => rpcOk(`0x${HASH}`),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", [RAW_TX])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    await expect(res.json()).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      result: `0x${HASH}`,
    });
  });

  it("sends a broadcast to the next provider when the first provider's breaker is open", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 500 }),
      "https://b.test/evm": (call) =>
        // oxlint-disable-next-line vitest/no-conditional-in-test -- picks the answer by method
        call.body.includes("eth_sendRawTransaction") ? rpcOk(`0x${HASH}`) : rpcOk("0x1"),
    });
    const app = gateway({ fetch: up.fetch });
    const first = await Promise.all(
      Array.from({ length: 5 }, async () =>
        app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId"))),
      ),
    );
    expect(first.map((res) => res.status)).toStrictEqual([200, 200, 200, 200, 200]);
    expect(up.callsTo("https://a.test")).toHaveLength(5);
    const res = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", [RAW_TX])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    expect(up.callsTo("https://a.test")).toHaveLength(5);
  });

  it("returns a provider's definitive rejection of a broadcast as the answer", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => rpcFailure(-32000, "already known"),
      "https://b.test/evm": () => rpcOk(`0x${HASH}`),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", [RAW_TX])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
    await expect(res.json()).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "already known" },
    });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("treats a batch containing a broadcast as a broadcast", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 500 }),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post([call("eth_chainId", [], 1), call("eth_sendRawTransaction", [RAW_TX], 2)]),
    );
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toStrictEqual({ error: "outcome-unknown" });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("still fails a read over on an ambiguous failure", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 500 }),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
  });

  it("answers outcome-unknown for an ambiguous Solana broadcast", async () => {
    const up = fakeFetch({
      "https://a.test/sol": () => new Response("bad gateway", { status: 502 }),
      "https://b.test/sol": () => rpcOk("sig"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${DEVNET}`,
      post(call("sendTransaction", ["AQID"])),
    );
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toStrictEqual({ error: "outcome-unknown" });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("answers outcome-unknown for an ambiguous Esplora broadcast", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () => new Response("bad gateway", { status: 502 }),
      "https://b.test/btc": () => new Response(HASH, { status: 200 }),
    });
    const res = await gateway({ fetch: up.fetch }).request(`/v1/esplora/${SIGNET}/tx`, {
      method: "POST",
      headers: headers({ "content-type": "text/plain" }),
      body: "0200000001",
    });
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toStrictEqual({ error: "outcome-unknown" });
    expect(up.callsTo("https://a.test")).toHaveLength(1);
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("fails an Esplora broadcast over when the provider provably refused the call", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () => new Response("slow down", { status: 429 }),
      "https://b.test/btc": () =>
        new Response(HASH, { status: 200, headers: { "content-type": "text/plain" } }),
    });
    const res = await gateway({ fetch: up.fetch }).request(`/v1/esplora/${SIGNET}/tx`, {
      method: "POST",
      headers: headers({ "content-type": "text/plain" }),
      body: "0200000001",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    await expect(res.text()).resolves.toBe(HASH);
  });
});

describe("esplora forwarding", () => {
  const base = `/v1/esplora/${SIGNET}`;

  it("passes allow-listed GET paths through with body and content-type intact", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () =>
        new Response("00000008819873e9", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });
    const res = await gateway({ fetch: up.fetch }).request(`${base}/block-height/0`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
    await expect(res.text()).resolves.toBe("00000008819873e9");
    expect(up.calls[0]?.url).toBe("https://a.test/btc/block-height/0");
  });

  it("covers every allow-listed GET path and returns JSON untouched", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () => Response.json({ "1": 5.2 }),
    });
    const app = gateway({ fetch: up.fetch });
    const paths = [
      "/fee-estimates",
      `/scripthash/${HASH}/txs`,
      `/scripthash/${HASH}/utxo`,
      `/tx/${HASH}/hex`,
      `/tx/${HASH}/status`,
    ];
    const responses = await Promise.all(
      paths.map(async (path) => app.request(`${base}${path}`, { headers: headers() })),
    );
    expect(responses.map((res) => res.status)).toStrictEqual(paths.map(() => 200));
    const bodies = await Promise.all(responses.map(async (res) => res.json()));
    expect(bodies).toStrictEqual(paths.map(() => ({ "1": 5.2 })));
    expect(up.calls.map((c) => c.url)).toStrictEqual(paths.map((p) => `https://a.test/btc${p}`));
  });

  it("passes POST /tx through with its text body", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () =>
        new Response(HASH, { status: 200, headers: { "content-type": "text/plain" } }),
    });
    const res = await gateway({ fetch: up.fetch }).request(`${base}/tx`, {
      method: "POST",
      headers: headers({ "content-type": "text/plain" }),
      body: "0200000001",
    });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(HASH);
    expect(up.calls[0]).toMatchObject({
      url: "https://a.test/btc/tx",
      method: "POST",
      body: "0200000001",
    });
  });

  it.each([
    ["GET", "/blocks"],
    ["GET", "/address/tb1qxyz/txs"],
    ["GET", `/tx/${HASH}`],
    ["GET", "/tx"],
    ["POST", "/fee-estimates"],
    ["GET", `/scripthash/${"AB".repeat(32)}/txs`],
    ["GET", ""],
  ])("rejects %s %s without calling upstream", async (method, path) => {
    const up = fakeFetch({ "https://a.test/btc": () => new Response("x") });
    const res = await gateway({ fetch: up.fetch }).request(`${base}${path}`, {
      method,
      headers: headers(),
    });
    expect(res.status).toBe(400);
    await expectContract(res, gatewayError);
    expect(up.calls).toHaveLength(0);
  });

  it.each([400, 404])("passes an upstream %i through without switching", async (status) => {
    const upstream = fakeFetch({
      "https://a.test/btc": () => new Response("upstream says no", { status }),
      "https://b.test/btc": () => new Response("late"),
    });
    const res = await gateway({ fetch: upstream.fetch }).request(`${base}/tx/${HASH}/hex`, {
      headers: headers(),
    });
    expect(res.status).toBe(status);
    await expect(res.text()).resolves.toBe("upstream says no");
    expect(upstream.callsTo("https://b.test")).toHaveLength(0);
  });

  it.each([500, 401, 403, 429])(
    "fails over to the next provider on upstream %i",
    async (status) => {
      const up = fakeFetch({
        "https://a.test/btc": () => new Response("", { status }),
        "https://b.test/btc": () => new Response("0000", { status: 200 }),
      });
      const res = await gateway({ fetch: up.fetch }).request(`${base}/block-height/0`, {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    },
  );

  it("answers 503 when every provider fails", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () => new Response("", { status: 500 }),
      "https://b.test/btc": () => new Response("", { status: 502 }),
    });
    const res = await gateway({ fetch: up.fetch }).request(`${base}/fee-estimates`, {
      headers: headers(),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });
});

describe("upstream response bounds", () => {
  const MIB = 1024 * 1024;
  const chunked = (chunks: ReadonlyArray<string>): Response =>
    new Response(
      new ReadableStream<string>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }).pipeThrough(new TextEncoderStream()),
    );

  it("answers 400 when an rpc response exceeds 8 MiB, without failover or breaker cost", async () => {
    const up = fakeFetch({
      "https://a.test/evm": onlyLogsCalls(() =>
        Response.json({ jsonrpc: "2.0", id: 1, result: "a".repeat(9 * MIB) }),
      ),
      "https://b.test/evm": onlyLogsCalls(() => rpcOk("0x1")),
    });
    const app = gateway({ fetch: up.fetch });
    const getLogs = post(call("eth_getLogs", [{ blockHash: `0x${HASH}` }]));
    const refused = await Promise.all(
      Array.from({ length: 5 }, async () => app.request(`/v1/rpc/${SEPOLIA}`, getLogs)),
    );
    expect(refused.map((res) => res.status)).toStrictEqual([400, 400, 400, 400, 400]);
    for (const res of refused) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential body reads
      await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    }
    expect(up.callsTo("https://b.test")).toHaveLength(0);
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
  });

  it("passes an rpc response just under the cap", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk(`0x${"ab".repeat(3 * MIB)}`),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_getBalance", [`0x${"11".repeat(20)}`])),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      result: `0x${"ab".repeat(3 * MIB)}`,
    });
  });

  it("cuts off a chunked rpc body with no content-length once it exceeds the cap", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () =>
        chunked([`{"jsonrpc":"2.0","id":1,"result":"`, "a".repeat(9 * MIB), `"}`]),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("answers 400 when an Esplora content-length exceeds the cap", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () =>
        new Response("x", { headers: { "content-length": String(17 * MIB) } }),
      "https://b.test/btc": () => new Response("late"),
    });
    const res = await gateway({ fetch: up.fetch }).request(`/v1/esplora/${SIGNET}/tx/${HASH}/hex`, {
      headers: headers(),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    expect(up.callsTo("https://b.test")).toHaveLength(0);
  });

  it("errors the stream when an Esplora body grows past the cap while read", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () => chunked(["0".repeat(8 * MIB), "0".repeat(8 * MIB), "0"]),
    });
    const res = await gateway({ fetch: up.fetch }).request(`/v1/esplora/${SIGNET}/tx/${HASH}/hex`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow(/upstream body exceeds/);
  });

  it("streams a normal Esplora response intact across chunks", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () => chunked(["0000", "1111", HASH]),
    });
    const res = await gateway({ fetch: up.fetch }).request(`/v1/esplora/${SIGNET}/tx/${HASH}/hex`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(`00001111${HASH}`);
  });
});

describe("rate limiting", () => {
  it("answers 429 with Retry-After when the binding refuses", async () => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk("0x1") });
    const app = gateway({
      fetch: up.fetch,
      limiters: { ip: allowAll, rpc: denyAll, default: denyAll },
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    await expect(expectContract(res, gatewayError)).resolves.toStrictEqual({
      error: "rate-limited",
    });
    expect(up.calls).toHaveLength(0);
  });

  it("keys the transport limiter by client id and client prefix, not the full address", async () => {
    const rpc = recordingLimiter();
    const dflt = recordingLimiter();
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk("0x1"),
      "https://a.test/btc": () => new Response("0"),
    });
    const app = gateway({ fetch: up.fetch, limiters: { ip: allowAll, rpc, default: dflt } });
    await app.request(`/v1/rpc/${SEPOLIA}`, {
      ...post(call("eth_chainId")),
      headers: headers({ "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" }),
    });
    await app.request(`/v1/esplora/${SIGNET}/block-height/0`, {
      headers: headers({ "cf-connecting-ip": "2001:db8:abcd:1234::1" }),
    });
    expect(rpc.keys).toStrictEqual([
      `${CLIENT_ID}:203.0.113.0/24`,
      `${CLIENT_ID}:2001:0db8:abcd::/48`,
    ]);
    expect(dflt.keys).toHaveLength(0);
  });

  it("bounds a client that rotates client ids by its IP prefix", async () => {
    const ip = recordingLimiter();
    let budget = 2;
    const app = gateway({
      fetch: fakeFetch({ "https://a.test/evm": () => rpcOk("0x1") }).fetch,
      limiters: {
        ip: {
          limit: async (options) => {
            await ip.limit(options);
            budget -= 1;
            return { success: budget >= 0 };
          },
        },
        rpc: allowAll,
        default: allowAll,
      },
    });
    const statuses = [];
    for (const id of ["a", "b", "c"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- requests are counted in order
      const res = await app.request(`/v1/rpc/${SEPOLIA}`, {
        ...post(call("eth_chainId")),
        headers: headers({
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.77",
          "x-client-id": id.repeat(32),
        }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toStrictEqual([200, 200, 429]);
    expect(ip.keys).toStrictEqual(Array.from({ length: 3 }, () => "203.0.113.0/24"));
  });

  it("charges a batch by the summed cost of its calls, not once per request", async () => {
    const ip = recordingLimiter();
    const rpc = recordingLimiter();
    const up = fakeFetch({
      "https://a.test/evm": () =>
        Response.json(
          Array.from({ length: 20 }, (_v, i) => ({ jsonrpc: "2.0", id: i, result: [] })),
        ),
    });
    const app = gateway({ fetch: up.fetch, limiters: { ip, rpc, default: allowAll } });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(maxCostLogsBatch()));
    expect(res.status).toBe(200);
    expect(up.callsTo("https://a.test")).toHaveLength(1);
    // One unit up front, then the batch's 200 scan units minus the unit already paid.
    expect(ip.deltas).toStrictEqual([1, 199]);
    expect(rpc.deltas).toStrictEqual([1, 199]);
  });

  it("refuses the next request once a batch spends the window's units", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () =>
        Response.json(
          Array.from({ length: 20 }, (_v, i) => ({ jsonrpc: "2.0", id: i, result: [] })),
        ),
    });
    const app = gateway({
      fetch: up.fetch,
      limiters: { ip: countBefore(100), rpc: countBefore(100), default: allowAll },
    });
    const first = await app.request(`/v1/rpc/${SEPOLIA}`, post(maxCostLogsBatch()));
    expect(first.status).toBe(200);
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(429);
    await expect(expectContract(res, gatewayError)).resolves.toStrictEqual({
      error: "rate-limited",
    });
    expect(up.calls).toHaveLength(1);
  });

  it("charges a single point call one unit and calls each limiter once", async () => {
    const ip = recordingLimiter();
    const rpc = recordingLimiter();
    const app = gateway({
      fetch: fakeFetch({ "https://a.test/evm": () => rpcOk("0xaa36a7") }).fetch,
      limiters: { ip, rpc, default: allowAll },
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(200);
    expect(ip.deltas).toStrictEqual([1]);
    expect(rpc.deltas).toStrictEqual([1]);
  });

  it("answers 429 without an upstream call when the batch's extra charge is refused", async () => {
    let limitCalls = 0;
    const refuseSecond: RateLimiter = {
      limit: async () => {
        limitCalls += 1;
        await Promise.resolve();
        return { success: limitCalls === 1 };
      },
    };
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const app = gateway({
      fetch: up.fetch,
      limiters: { ip: refuseSecond, rpc: allowAll, default: allowAll },
    });
    const res = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post([call("eth_chainId"), call("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1f4" }])]),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    await expect(expectContract(res, gatewayError)).resolves.toStrictEqual({
      error: "rate-limited",
    });
    expect(up.calls).toHaveLength(0);
  });

  it("charges an Esplora request one unit — every allow-listed path is bounded", async () => {
    const rpc = recordingLimiter();
    const app = gateway({
      fetch: fakeFetch({ "https://a.test/btc": () => new Response("0") }).fetch,
      limiters: { ip: allowAll, rpc, default: allowAll },
    });
    const res = await app.request(`/v1/esplora/${SIGNET}/block-height/0`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    expect(rpc.deltas).toStrictEqual([1]);
  });

  it("does not count health", async () => {
    const rpc = recordingLimiter();
    const app = gateway({ fetch: fakeFetch({}).fetch, limiters: { ip: rpc, rpc, default: rpc } });
    await app.request("/v1/health");
    expect(rpc.keys).toHaveLength(0);
  });

  it("derives /24 and /48 prefixes", () => {
    expect(ipPrefix("198.51.100.200")).toBe("198.51.100.0/24");
    expect(ipPrefix("2001:db8::1")).toBe("2001:0db8:0000::/48");
    expect(ipPrefix("fe80::1:2:3:4")).toBe("fe80:0000:0000::/48");
    expect(ipPrefix("2001:db8:1:2:3:4:5:6")).toBe("2001:0db8:0001::/48");
    expect(ipPrefix(undefined)).toBe("unknown");
    expect(ipPrefix("nonsense")).toBe("unknown");
  });
});

describe("cors", () => {
  it("answers preflight for an allowed origin without an client id", async () => {
    const res = await gateway({ fetch: fakeFetch({}).fetch }).request(`/v1/rpc/${SEPOLIA}`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("does not grant other origins", async () => {
    const res = await gateway({ fetch: fakeFetch({}).fetch }).request("/v1/health", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("request log", () => {
  it("records route template, status, duration and provider only", async () => {
    const lines: string[] = [];
    const address = "0x52908400098527886E0F7030069857D2E4169EE7";
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk("0x1"),
      "https://a.test/btc": () => new Response("[]"),
    });
    const app = gateway({ fetch: up.fetch, log: (line) => lines.push(line) });
    await app.request(`/v1/rpc/${SEPOLIA}`, {
      ...post(call("eth_getBalance", [address, "latest"])),
      headers: headers({ "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" }),
    });
    await app.request(`/v1/esplora/${SIGNET}/scripthash/${HASH}/txs`, { headers: headers() });
    await app.request("/v1/health");

    expect(lines).toHaveLength(3);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const record of records) {
      expect(Object.keys(record).toSorted()).toStrictEqual(["ms", "provider", "route", "status"]);
    }
    expect(records.map((r) => r["route"])).toStrictEqual([
      "/v1/rpc/:caip2",
      "/v1/esplora/:caip2/*",
      "/v1/health",
    ]);
    expect(records.map((r) => r["status"])).toStrictEqual([200, 200, 200]);
    expect(records.map((r) => r["provider"])).toStrictEqual(["a", "a", null]);
    const text = lines.join("\n");
    for (const secret of [
      address,
      address.toLowerCase(),
      HASH,
      "203.0.113",
      CLIENT_ID,
      "eth_getBalance",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("logs failures with their status and no detail", async () => {
    const lines: string[] = [];
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 500 }),
      "https://b.test/evm": () => new Response("", { status: 500 }),
    });
    const app = gateway({ fetch: up.fetch, log: (line) => lines.push(line) });
    await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({
        route: "/v1/rpc/:caip2",
        status: 503,
        provider: null,
      }),
    );
  });
});

describe("upstream observability", () => {
  const capture = (): { lines: string[]; log: (line: string) => void } => {
    const lines: string[] = [];
    return { lines, log: (line) => lines.push(line) };
  };
  const events = (lines: string[]): Array<Record<string, unknown>> =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry["event"] !== undefined);

  it.each<[string, Upstream, string, number]>([
    ["status-503", () => new Response("", { status: 503 }), "status-503", 200],
    ["malformed", () => new Response("not json"), "malformed", 200],
    [
      "transport",
      () => {
        throw new TypeError("connect refused");
      },
      "transport",
      200,
    ],
    ["rejected", () => new Response("nope", { status: 400 }), "rejected", 400],
  ])(
    "logs %s for a failed attempt and never logs request data",
    async (_label, answer, reason, status) => {
      const { lines, log } = capture();
      const up = fakeFetch({
        "https://a.test/evm": answer,
        "https://b.test/evm": () => rpcOk("0x1"),
      });
      const app = gateway({ fetch: up.fetch, log });
      const res = await app.request(
        `/v1/rpc/${SEPOLIA}`,
        post(call("eth_getBalance", ["0xdead00000000000000000000000000000000beef", "latest"])),
      );
      expect(res.status).toBe(status);
      expect(events(lines)).toStrictEqual([
        {
          event: "upstream-failure",
          provider: "a",
          upstream: "https://a.test/evm",
          reason,
        },
      ]);
      const joined = lines.join("\n");
      expect(joined).not.toContain("0xdead00000000000000000000000000000000beef");
      expect(joined).not.toContain(CLIENT_ID);
    },
  );

  it("logs auth for a provider whose auth lookup fails", async () => {
    const { lines, log } = capture();
    const up = fakeFetch({ "https://b.test/evm": () => rpcOk("0x1") });
    const app = gateway({
      fetch: up.fetch,
      log,
      networks: [
        {
          id: SEPOLIA,
          providers: [
            { id: "a", url: "https://a.test/evm", auth: "alchemy" },
            { id: "b", url: "https://b.test/evm" },
          ],
        },
      ],
      auth: {
        alchemy: async () => Promise.reject(new Error("no credentials")),
      },
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(200);
    expect(up.callsTo("https://a.test")).toHaveLength(0);
    expect(events(lines)).toStrictEqual([
      {
        event: "upstream-failure",
        provider: "a",
        upstream: "https://a.test/evm",
        reason: "auth",
      },
    ]);
    expect(lines.join("\n")).not.toContain("no credentials");
  });

  it("logs timeout for an upstream that never answers", async () => {
    vi.useFakeTimers();
    const { lines, log } = capture();
    const up = fakeFetch({
      "https://a.test/evm": async (_c, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const pending = gateway({ fetch: up.fetch, log }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(events(lines)).toStrictEqual([
      {
        event: "upstream-failure",
        provider: "a",
        upstream: "https://a.test/evm",
        reason: "timeout",
      },
    ]);
  });

  it("logs breaker-open for a skipped provider and the open, half-open, closed transitions", async () => {
    vi.useFakeTimers();
    const { lines, log } = capture();
    let attempts = 0;
    const up = fakeFetch({
      "https://a.test/evm": () => {
        attempts += 1;
        // oxlint-disable-next-line vitest/no-conditional-in-test -- staged answers per attempt
        return attempts <= 5 ? new Response("", { status: 500 }) : rpcOk("0x1");
      },
      "https://b.test/evm": () => rpcOk("0x1"),
    });
    const app = gateway({ fetch: up.fetch, log });
    await Promise.all(
      Array.from({ length: 5 }, async () =>
        app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId"))),
      ),
    );
    expect(up.callsTo("https://a.test")).toHaveLength(5);

    const skipped = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(skipped.status).toBe(200);
    expect(up.callsTo("https://a.test")).toHaveLength(5);
    expect(events(lines)).toContainEqual({
      event: "upstream-failure",
      provider: "a",
      upstream: "https://a.test/evm",
      reason: "breaker-open",
    });
    expect(events(lines)).toContainEqual({
      event: "breaker",
      provider: "a",
      upstream: "https://a.test/evm",
      state: "open",
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const recovered = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get(PROVIDERS_HEADER)).toBe("a");
    expect(events(lines)).toStrictEqual(
      expect.arrayContaining([
        { event: "breaker", provider: "a", upstream: "https://a.test/evm", state: "open" },
        { event: "breaker", provider: "a", upstream: "https://a.test/evm", state: "half-open" },
        { event: "breaker", provider: "a", upstream: "https://a.test/evm", state: "closed" },
      ]),
    );
  });

  it("logs all-providers-failed once when every provider of a run fails", async () => {
    const { lines, log } = capture();
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 500 }),
      "https://b.test/evm": () => new Response("", { status: 500 }),
    });
    const res = await gateway({ fetch: up.fetch, log }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_chainId")),
    );
    expect(res.status).toBe(503);
    expect(events(lines)).toStrictEqual([
      {
        event: "upstream-failure",
        provider: "a",
        upstream: "https://a.test/evm",
        reason: "status-500",
      },
      {
        event: "upstream-failure",
        provider: "b",
        upstream: "https://b.test/evm",
        reason: "status-500",
      },
      { event: "all-providers-failed", providers: ["a", "b"] },
    ]);
  });

  it("logs only the error name for an unexpected failure", async () => {
    const { lines, log } = capture();
    const res = await gateway({
      fetch: fakeFetch({}).fetch,
      log,
      limiters: {
        ip: { limit: async () => Promise.reject(new RangeError("quota exploded")) },
        rpc: allowAll,
        default: allowAll,
      },
    }).request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toStrictEqual({ error: "internal" });
    expect(events(lines)).toStrictEqual([{ event: "internal-error", name: "RangeError" }]);
    expect(lines.join("\n")).not.toContain("quota exploded");
  });
});
