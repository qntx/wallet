import { describe, expect, it } from "vite-plus/test";

import {
  EVM_RPC_METHODS,
  SOLANA_RPC_METHODS,
  historyPath,
  rpcPath,
} from "@qntx/wallet-engine/gateway/contract";
import type { EvmRpcMethod, SolanaRpcMethod } from "@qntx/wallet-engine/gateway/contract";

import { ALCHEMY_COSTS } from "../src/budget/costs.ts";
import type { CostModel, CostRow } from "../src/budget/costs.ts";
import { localBudget } from "../src/budget/local.ts";
import { PRODUCTION_ACCOUNTS } from "../src/config/accounts.ts";
import type { Account } from "../src/config/accounts.ts";
import type { GatewayNetwork, ProviderBudget } from "../src/types.ts";
import {
  allowAll,
  call,
  recordingLimiter,
  TEST_ACCOUNTS,
  countBefore,
  fakeFetch,
  gateway,
  headers,
  post,
  productionGateway,
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
  alchemy: {
    costs: ALCHEMY_COSTS,
    budget: [{ units: 40_000, seconds: 5 }],
    clientShare: 0.05,
  },
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
      alchemy: {
        costs: ALCHEMY_COSTS,
        budget: [{ units: 60, seconds: 60 }],
        clientShare: 0.05,
      },
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

describe("one billed unit per upstream call", () => {
  it("bills dRPC's formerly free identity reads one request unit each", async () => {
    // eth_chainId costs dRPC 0 CU, but rate limiting bills every call at least once — so the
    // production row is request-priced and three reads charge the share and budget three units.
    const upstream = fakeFetch({
      "https://lb.drpc.live": () => rpcOk("0xa4b1"),
      "https://rpc.ankr.com": () => rpcOk("0xa4b1"),
    });
    const share = recordingLimiter();
    const takes: Array<{ account: string; units: number }> = [];
    const inner = localBudget(PRODUCTION_ACCOUNTS, Date.now);
    const budget: ProviderBudget = {
      take: async (account, units) => {
        takes.push({ account, units });
        return inner.take(account, units);
      },
    };
    const app = productionGateway({ fetch: upstream.fetch, share, budget });
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const res = await app.request("/v1/rpc/eip155:42170", post(call("eth_chainId", [], i + 1)));
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      expect(res.status).toBe(200);
    }
    expect(upstream.callsTo("https://lb.drpc.live")).toHaveLength(3);
    expect(upstream.callsTo("https://rpc.ankr.com")).toHaveLength(0);
    expect(share.keys.filter((key) => key.startsWith("drpc:"))).toHaveLength(3);
    expect(takes.filter((take) => take.account === "drpc")).toStrictEqual([
      { account: "drpc", units: 1 },
      { account: "drpc", units: 1 },
      { account: "drpc", units: 1 },
    ]);
  });

  it("floors a method row priced at zero to one billed unit", async () => {
    // An rpc-priced account whose rows all resolve to zero still pays one unit per call.
    const costs: CostModel = {
      kind: "rpc",
      methods: Object.fromEntries(
        [...EVM_RPC_METHODS, ...SOLANA_RPC_METHODS].map((method) => [
          method,
          { units: 0, source: "https://test.invalid" },
        ]),
      ) as Readonly<Record<EvmRpcMethod | SolanaRpcMethod, CostRow>>,
    };
    const accounts: Readonly<Record<string, Account>> = {
      ...TEST_ACCOUNTS,
      a: { costs, budget: [{ units: 1_000_000, seconds: 60 }], clientShare: 0.05 },
    };
    const share = recordingLimiter();
    const takes: Array<{ account: string; units: number }> = [];
    const budget: ProviderBudget = {
      take: async (account, units) => {
        takes.push({ account, units });
        await Promise.resolve();
        return { ok: true };
      },
    };
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk("0xaa") });
    // One RPC network: the default table also wires "a" into Esplora, which demands request pricing.
    const networks: ReadonlyArray<GatewayNetwork> = [
      { id: "eip155:11155111", providers: [{ id: "a", url: "https://a.test/evm" }] },
    ];
    const app = gateway({
      fetch: up.fetch,
      networks,
      accounts,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share },
      budget,
    });
    const res = await app.request("/v1/rpc/eip155:11155111", post(call("eth_chainId")));
    expect(res.status).toBe(200);
    expect(share.keys.filter((key) => key.startsWith("a:"))).toHaveLength(1);
    expect(takes).toStrictEqual([{ account: "a", units: 1 }]);
  });
});
