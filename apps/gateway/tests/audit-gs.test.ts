import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  accepts,
  decodeHashList,
  evmRpcRequest,
} from "@qntx/wallet-engine/gateway/contract";

import type { PhishingSource } from "../src/config/phishing.ts";
import { SNAPSHOT_KEY, buildPhishingList } from "../src/risk/phishing.ts";
import {
  SEPOLIA,
  allowAll,
  call,
  fakeFetch,
  gateway,
  headers,
  memoryRiskStore,
  post,
  recordingLimiter,
  rpcFailure,
  rpcOk,
} from "./helpers.ts";
import type { Upstream, UpstreamCall } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

const sentBodies = (calls: UpstreamCall[]): unknown[] =>
  calls.map((c) => JSON.parse(c.body) as unknown);

const failOnGetLogs =
  (status: number): Upstream =>
  (upstream) =>
    upstream.body.includes("eth_getLogs") ? new Response("x", { status }) : rpcOk("0xaa36a7");

const storedSnapshot = (store: ReturnType<typeof memoryRiskStore>) =>
  JSON.parse(store.data.get(SNAPSHOT_KEY) ?? "{}") as {
    version: number;
    deny: string;
    allow: string;
  };

describe("audit GS", () => {
  it("GS-A one HTTP request carries 20 max-cost eth_getLogs calls and counts once per limiter", async () => {
    const ip = recordingLimiter();
    const rpc = recordingLimiter();
    const up = fakeFetch({
      "https://a.test/evm": () =>
        Response.json(
          Array.from({ length: 20 }, (_v, i) => ({ jsonrpc: "2.0", id: i, result: [] })),
        ),
    });
    const app = gateway({
      fetch: up.fetch,
      limiters: { ip, rpc, default: allowAll },
    });
    const batch = Array.from({ length: 20 }, (_v, i) =>
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
            topics: [
              Array.from({ length: 20 }, (_t, k) => `0x${k.toString(16).padStart(64, "0")}`),
            ],
          },
        ],
        i,
      ),
    );
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(batch));
    expect(res.status).toBe(200);
    expect(ip.keys).toHaveLength(1);
    expect(rpc.keys).toHaveLength(1);
    expect(up.callsTo("https://a.test")).toHaveLength(1);
    const sent = sentBodies(up.callsTo("https://a.test"));
    expect(sent[0]).toHaveLength(20);
  });

  it("GS-B recent-block tags bypass the 500-block bound", async () => {
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk([]) });
    const app = gateway({ fetch: up.fetch });
    const finalized = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_getLogs", [{ fromBlock: "finalized", toBlock: "latest" }])),
    );
    expect(finalized.status).toBe(200);
    expect(up.callsTo("https://a.test")).toHaveLength(1);
    const pending = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_getLogs", [{ fromBlock: "safe", toBlock: "pending" }])),
    );
    expect(pending.status).toBe(200);
    expect(up.callsTo("https://a.test")).toHaveLength(2);
    const numbered = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x1f4" }])),
    );
    expect(numbered.status).toBe(400);
    expect(up.callsTo("https://a.test")).toHaveLength(2);
    expect(
      accepts(evmRpcRequest, call("eth_getLogs", [{ fromBlock: "finalized", toBlock: "latest" }])),
    ).toBe(true);
  });

  it.each([400, 413, 429])(
    "GS-C one client's chosen requests open the shared breakers for every client (upstream %i)",
    async (status) => {
      const up = fakeFetch({
        "https://a.test/evm": failOnGetLogs(status),
        "https://b.test/evm": failOnGetLogs(status),
      });
      const app = gateway({ fetch: up.fetch });

      const before = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
      expect(before.status).toBe(200);
      expect(before.headers.get(PROVIDERS_HEADER)).toBe("a");

      const attackerPost = {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          "x-install-id": "f".repeat(32),
        }),
        body: JSON.stringify(call("eth_getLogs", [{ blockHash: `0x${"ab".repeat(32)}` }])),
      } as const;
      for (let n = 0; n < 5; n += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential requests build the streak
        const res = await app.request(`/v1/rpc/${SEPOLIA}`, attackerPost);
        expect(res.status).toBe(503);
      }

      const callsBeforeVictim = up.calls.length;
      const victim = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
      expect(victim.status).toBe(503);
      await expect(victim.json()).resolves.toStrictEqual({ error: "unavailable" });
      expect(victim.headers.get("retry-after")).toBe("30");
      expect(up.calls).toHaveLength(callsBeforeVictim);
    },
  );

  it("GS-D the upstream response is buffered and relayed without a size bound", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk("a".repeat(32 * 1024 * 1024)),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_getBlockReceipts", ["0x1"])),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(32 * 1024 * 1024);
  });

  it("GS-E an ambiguous broadcast becomes a definitive JSON-RPC error", async () => {
    const rawTx = `0x02${"ab".repeat(64)}`;
    const up = fakeFetch({
      "https://a.test/evm": () => new Response("bad gateway", { status: 502 }),
      "https://b.test/evm": () => rpcFailure(-32000, "already known"),
    });
    const res = await gateway({ fetch: up.fetch }).request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", [rawTx])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    await expect(res.json()).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "already known" },
    });
    expect(up.callsTo("https://a.test")).toHaveLength(1);
    expect(sentBodies(up.callsTo("https://a.test"))[0]).toMatchObject({
      method: "eth_sendRawTransaction",
      params: [rawTx],
    });
  });

  it("GS-E an ambiguous broadcast after the 10 s timeout still resolves to a JSON-RPC error", async () => {
    vi.useFakeTimers();
    const rawTx = `0x02${"cd".repeat(64)}`;
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
      post(call("eth_sendRawTransaction", [rawTx])),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    await expect(res.json()).resolves.toStrictEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "already known" },
    });
    expect(up.callsTo("https://a.test")).toHaveLength(1);
    expect(sentBodies(up.callsTo("https://a.test"))[0]).toMatchObject({
      method: "eth_sendRawTransaction",
      params: [rawTx],
    });
  });

  it("GS-F-build an allow list mirroring every deny key is accepted; removing the same keys is not", async () => {
    const deny = Array.from({ length: 100 }, (_v, i) => `x${i}.pages.dev`);
    let denyEntries = deny;
    let allowEntries: string[] = [];
    const sources: ReadonlyArray<PhishingSource> = [
      { id: "a", url: "https://a.test/list", parse: () => ({ deny: denyEntries, allow: [] }) },
      { id: "b", url: "https://b.test/list", parse: () => ({ deny: [], allow: allowEntries }) },
    ];
    const store = memoryRiskStore();
    const lines: string[] = [];
    let clock = 1_000_000;
    const up = fakeFetch({
      "https://a.test/list": () => Response.json({}),
      "https://b.test/list": () => Response.json({}),
    });
    const build = async () =>
      buildPhishingList({
        fetch: up.fetch,
        store,
        now: () => clock,
        log: (line) => lines.push(line),
        sources,
      });

    await build();
    const first = storedSnapshot(store);

    clock += 3_600_000;
    allowEntries = deny;
    await build();
    const second = storedSnapshot(store);
    expect(second.version).toBeGreaterThan(first.version);
    expect(lines.some((line) => line.includes("phishing-build-skipped"))).toBe(false);
    expect(second.allow).toBe(second.deny);
    expect(decodeHashList(second.allow)).toHaveLength(100 * 8);

    clock += 3_600_000;
    allowEntries = [];
    denyEntries = [];
    await build();
    expect(storedSnapshot(store).version).toBe(second.version);
    expect(lines.at(-1)).toContain("deny-shrank");
  });
});
