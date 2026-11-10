import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  gatewayError,
  health,
  rpcResponse,
  servedNetworksResponse,
} from "@qntx/wallet-engine/gateway/contract";

import { ipPrefix } from "../src/middleware/rate-limit.ts";
import {
  DEVNET,
  INSTALL_ID,
  MAINNET_BITCOIN,
  ORIGIN,
  SEPOLIA,
  SIGNET,
  call,
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

const HASH = "ab".repeat(32);

afterEach(() => {
  vi.useRealTimers();
});

describe("health and identity", () => {
  it("serves health without an install id and matches the contract", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch });
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    await expectContract(res, health.response);
  });

  it.each([
    ["missing", {}],
    ["too short", { "x-install-id": "abcd" }],
    ["uppercase", { "x-install-id": INSTALL_ID.toUpperCase() }],
    ["not hex", { "x-install-id": "z".repeat(32) }],
  ])("rejects a %s install id with 400", async (_name, h) => {
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

  it("requires an install id and counts against the default limiter", async () => {
    const rpc = recordingLimiter();
    const dflt = recordingLimiter();
    const app = gateway({ fetch: fakeFetch({}).fetch, limiters: { rpc, default: dflt } });
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
      limiters: { rpc: denyAll, default: denyAll },
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
      post(call("eth_call")),
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

  it("forwards eth_simulateV1 as a read", async () => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_simulateV1", [{ blockStateCalls: [] }, "latest"])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("a");
  });

  it("forwards eth_sendRawTransaction and fails over like any read", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("", { status: 503 }),
      "https://b.test/evm": () => rpcOk(`0x${HASH}`),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", ["0x02"])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
  });

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

describe("rate limiting", () => {
  it("answers 429 with Retry-After when the binding refuses", async () => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk("0x1") });
    const app = gateway({ fetch: up.fetch, limiters: { rpc: denyAll, default: denyAll } });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    await expect(expectContract(res, gatewayError)).resolves.toStrictEqual({
      error: "rate-limited",
    });
    expect(up.calls).toHaveLength(0);
  });

  it("keys the transport limiter by install id and client prefix, not the full address", async () => {
    const rpc = recordingLimiter();
    const dflt = recordingLimiter();
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk("0x1"),
      "https://a.test/btc": () => new Response("0"),
    });
    const app = gateway({ fetch: up.fetch, limiters: { rpc, default: dflt } });
    await app.request(`/v1/rpc/${SEPOLIA}`, {
      ...post(call("eth_chainId")),
      headers: headers({ "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" }),
    });
    await app.request(`/v1/esplora/${SIGNET}/block-height/0`, {
      headers: headers({ "cf-connecting-ip": "2001:db8:abcd:1234::1" }),
    });
    expect(rpc.keys).toStrictEqual([
      `${INSTALL_ID}:203.0.113.0/24`,
      `${INSTALL_ID}:2001:0db8:abcd::/48`,
    ]);
    expect(dflt.keys).toHaveLength(0);
  });

  it("does not count health", async () => {
    const rpc = recordingLimiter();
    const app = gateway({ fetch: fakeFetch({}).fetch, limiters: { rpc, default: rpc } });
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
  it("answers preflight for an allowed origin without an install id", async () => {
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
      INSTALL_ID,
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
    expect(JSON.parse(lines.join(""))).toMatchObject({
      route: "/v1/rpc/:caip2",
      status: 503,
      provider: null,
    });
  });
});
