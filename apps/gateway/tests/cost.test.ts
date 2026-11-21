import { describe, expect, it } from "vite-plus/test";

import { historyPath, rpcPath } from "@qntx/wallet-engine/gateway/contract";

import { ALCHEMY_COSTS } from "../src/budget/costs.ts";
import type { Account } from "../src/config/accounts.ts";
import type { GatewayNetwork } from "../src/types.ts";
import {
  allowAll,
  call,
  recordingLimiter,
  TEST_ACCOUNTS,
  countBefore,
  fakeFetch,
  gateway,
  headers,
  rpcOk,
} from "./helpers.ts";

const IP = "203.0.113.7";
const PREFIX = "203.0.113.0/24";
const ETH = "eip155:1";
const ALCHEMY = "https://eth-mainnet.g.alchemy.com/v2";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  { id: ETH, providers: [{ id: "alchemy", url: ALCHEMY }] },
];

/** The production Alchemy row: its window refills 40,000 units every 5 s → 480,000 a minute. */
const ACCOUNTS: Readonly<Record<string, Account>> = {
  ...TEST_ACCOUNTS,
  alchemy: { costs: ALCHEMY_COSTS, budget: [{ units: 40_000, seconds: 5 }] },
};
const PER_MINUTE = 40_000 * (60 / 5);
/** The share limiter sells one IP at most 5 % of the account's per-minute budget. */
const SHARE_CAP = PER_MINUTE / 20;

const freshId = (n: number): string => n.toString(16).padStart(32, "0");
const jsonPost = (clientId: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: headers({
    "content-type": "application/json",
    "cf-connecting-ip": IP,
    "x-client-id": clientId,
  }),
  body: JSON.stringify(body),
});

/** An asset-transfers page with no transfers and no page key — the cheapest full answer. */
const emptyTransfers = (): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [] } });

describe("provider-cost metering", () => {
  it("history: one /24 with rotating client ids cannot exceed 5 % of the per-minute budget", async () => {
    const up = fakeFetch({ [ALCHEMY]: emptyTransfers });
    const share = countBefore(1000);
    const app = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: countBefore(300), rpc: countBefore(100), default: countBefore(50), share },
      accounts: ACCOUNTS,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 160; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential client on purpose
      const res = await app.request(historyPath(ETH), jsonPost(freshId(i), { address: OWNER }));
      statuses.push(res.status);
    }
    const calls = up.callsTo(ALCHEMY).length;
    // alchemy_getAssetTransfers is 120 CU: 240 CU of work per request overshoots once at most.
    expect(calls * 120).toBeLessThanOrEqual(SHARE_CAP + 240);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const key = `alchemy:${PREFIX}`;
    expect(share.counts.has(key)).toBe(true);
    expect(share.counts.get(key)).toBeLessThanOrEqual(1000);
  });

  it("rpc: eth_getLogs is billed per upstream compute unit, not per request", async () => {
    const blockHash = `0x${"ab".repeat(32)}`;
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk([]) });
    const share = countBefore(1000);
    const app = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: countBefore(300), rpc: countBefore(100), default: countBefore(50), share },
      accounts: ACCOUNTS,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential client on purpose
      const res = await app.request(
        rpcPath(ETH),
        jsonPost(freshId(i), call("eth_getLogs", [{ blockHash }])),
      );
      statuses.push(res.status);
    }
    const calls = up.callsTo(ALCHEMY).length;
    // eth_getLogs is 60 CU: one refused call overshoots by 60 at most.
    expect(calls * 60).toBeLessThanOrEqual(SHARE_CAP + 60);
    const key = `alchemy:${PREFIX}`;
    expect(share.counts.has(key)).toBe(true);
    expect(share.counts.get(key)).toBeLessThanOrEqual(1000);
  });

  it("one request costing more than the whole client window is refused 413 before the limiter", async () => {
    // A tiny account: each chainId costs 5 CU, and 5 % of a 60/min budget is 3 share units —
    // the ceiling check refuses before the limiter is even asked.
    const tiny: Readonly<Record<string, Account>> = {
      ...TEST_ACCOUNTS,
      alchemy: { costs: ALCHEMY_COSTS, budget: [{ units: 60, seconds: 60 }] },
    };
    const share = recordingLimiter();
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk("0x1") });
    const app = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share },
      accounts: tiny,
    });
    const res = await app.request(rpcPath(ETH), jsonPost(freshId(1), call("eth_chainId")));
    expect(res.status).toBe(413);
    expect(share.keys).toHaveLength(0);
    expect(up.callsTo(ALCHEMY)).toHaveLength(0);
  });

  it("a refused share charge never reaches the upstream", async () => {
    const up = fakeFetch({ [ALCHEMY]: () => rpcOk("0x1") });
    const app = gateway({
      fetch: up.fetch,
      networks: NETWORKS,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share: countBefore(0) },
      accounts: ACCOUNTS,
    });
    const res = await app.request(rpcPath(ETH), jsonPost(freshId(1), call("eth_chainId")));
    expect(res.status).toBe(429);
    expect(up.callsTo(ALCHEMY)).toHaveLength(0);
  });
});
