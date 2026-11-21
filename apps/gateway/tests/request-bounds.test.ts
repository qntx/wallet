import { describe, expect, it } from "vite-plus/test";

import { rpcPath } from "@qntx/wallet-engine/gateway/contract";

import { ALCHEMY_COSTS } from "../src/budget/costs.ts";
import type { Account } from "../src/config/accounts.ts";
import type { GatewayNetwork } from "../src/types.ts";
import {
  TEST_ACCOUNTS,
  allowAll,
  call,
  countBefore,
  fakeFetch,
  gateway,
  headers,
  rpcOk,
} from "./helpers.ts";

const IP = "203.0.113.7";
const ETH = "eip155:1";
const ALCHEMY = "https://eth-mainnet.g.alchemy.com/v2";
const DRPC = "https://lb.drpc.live/ethereum";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  { id: ETH, providers: [{ id: "alchemy", url: ALCHEMY }] },
];
const DRPC_NETWORKS: ReadonlyArray<GatewayNetwork> = [
  { id: ETH, providers: [{ id: "drpc", url: DRPC }] },
];

/** The production account rows: alchemy 40k units / 5 s, drpc 400 calls / 5 s, public 20 / 2 s. */
const ACCOUNTS: Readonly<Record<string, Account>> = {
  ...TEST_ACCOUNTS,
  alchemy: {
    costs: ALCHEMY_COSTS,
    budget: [{ units: 40_000, seconds: 5 }],
    clientShare: 0.05,
  },
  drpc: {
    costs: {
      kind: "request",
      request: { units: 1, source: "https://drpc.org/docs/howitworks/ratelimiting" },
    },
    budget: [{ units: 400, seconds: 5 }],
    clientShare: 0.05,
  },
};

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: headers({ "content-type": "application/json", "cf-connecting-ip": IP }),
  body: JSON.stringify(body),
});

describe("per-request parameter bounds", () => {
  it("the engine's own fee-history usage stays inside the bound", async () => {
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, accounts: ACCOUNTS });
    const res = await app.request(
      rpcPath(ETH),
      post(call("eth_feeHistory", [20, "latest", [25, 50, 75]])),
    );
    expect(res.status).toBe(200);
    expect(up.callsTo(ALCHEMY)).toHaveLength(1);
  });

  it("the engine's own one-block simulation stays inside the bounds", async () => {
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, accounts: ACCOUNTS });
    const res = await app.request(
      rpcPath(ETH),
      post(
        call("eth_simulateV1", [
          { blockStateCalls: [{ calls: [{ from: OWNER, to: OWNER, value: "0x0" }] }] },
        ]),
      ),
    );
    expect(res.status).toBe(200);
    expect(up.callsTo(ALCHEMY)).toHaveLength(1);
  });

  it("a 5000-key eth_getProof is refused 400 before any upstream call", async () => {
    const keys = Array.from({ length: 5000 }, (_v, i) => `0x${i.toString(16).padStart(64, "0")}`);
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, accounts: ACCOUNTS });
    const res = await app.request(
      rpcPath(ETH),
      post(call("eth_getProof", [OWNER, keys, "latest"])),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    expect(up.calls).toHaveLength(0);
  });

  it("a 3000-call eth_simulateV1 is refused 400 before any upstream call", async () => {
    const block = { calls: Array.from({ length: 200 }, () => ({ from: OWNER, to: OWNER })) };
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk({}) });
    const app = gateway({ fetch: up.fetch, networks: NETWORKS, accounts: ACCOUNTS });
    const res = await app.request(
      rpcPath(ETH),
      post(call("eth_simulateV1", [{ blockStateCalls: Array.from({ length: 15 }, () => block) }])),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    expect(up.calls).toHaveLength(0);
  });

  it("a valid batch costing more than the whole client window is 413 too-costly", async () => {
    // The account's per-minute budget is 60 units: 20 calls × 5 CU = 100 units of work,
    // a delta of 1,667 share units — more than the whole 1,000-unit window.
    const tiny: Readonly<Record<string, Account>> = {
      ...TEST_ACCOUNTS,
      alchemy: {
        costs: ALCHEMY_COSTS,
        budget: [{ units: 60, seconds: 60 }],
        clientShare: 0.05,
      },
    };
    const share = countBefore(1000);
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk({}) });
    const app = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share },
      accounts: tiny,
    });
    const batch = Array.from({ length: 20 }, (_v, i) => call("eth_chainId", [], i + 1));
    const res = await app.request(rpcPath(ETH), post(batch));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toStrictEqual({ error: "too-costly" });
    expect(share.counts.size).toBe(0);
    expect(up.calls).toHaveLength(0);
  });

  it("the most expensive valid batch still fits one client window on the production accounts", async () => {
    // 20 × eth_getBlockReceipts: 500 CU on alchemy → delta 417; 20 CU on drpc → delta 84.
    const batch = Array.from({ length: 20 }, (_v, i) =>
      call("eth_getBlockReceipts", ["latest"], i + 1),
    );
    for (const [networks, upstream] of [
      [NETWORKS, ALCHEMY],
      [DRPC_NETWORKS, DRPC],
    ] as const) {
      const up = fakeFetch({
        [upstream]: () =>
          Response.json(batch.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] }))),
      });
      const app = gateway({ fetch: up.fetch, networks, accounts: ACCOUNTS });
      // oxlint-disable-next-line eslint/no-await-in-loop -- one provider per iteration
      const res = await app.request(rpcPath(ETH), post(batch));
      expect(res.status).toBe(200);
      expect(up.callsTo(upstream)).toHaveLength(1);
    }
  });
});
