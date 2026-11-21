/**
 * DRPC prices chain-identity reads at 0 CU (`eth_chainId`, `net_version`, `web3_clientVersion`),
 * and `sendTo` skips both the share meter (units <= 0) and the budget take — so on a dRPC-first
 * network like Arbitrum Nova (eip155:42170) 500 of these calls from one IP reach the upstream
 * unbilled and unmetered: zero `drpc:` share keys, zero `drpc` budget takes. A priced method
 * (`eth_blockNumber`, 20 CU) is metered, as a control.
 */
import { describe, expect, it } from "vite-plus/test";

import { localBudget } from "../../src/budget/local.ts";
import { PRODUCTION_ACCOUNTS } from "../../src/config/accounts.ts";
import type { ProviderBudget } from "../../src/types.ts";
import { call, fakeFetch, headers, post, recordingLimiter, rpcOk } from "../helpers.ts";
import { counts, productionApp } from "./setup.ts";

const IP = "198.51.100.71";
const at = { "cf-connecting-ip": IP };

const upstream = fakeFetch({
  "https://lb.drpc.live": () => rpcOk("0x1"),
  "https://rpc.ankr.com": () => rpcOk("0x1"),
});

const share = recordingLimiter();
const inner = localBudget(PRODUCTION_ACCOUNTS, Date.now);
const takes: Array<{ account: string; units: number }> = [];
const budget: ProviderBudget = {
  take: async (account, units) => {
    takes.push({ account, units });
    return inner.take(account, units);
  },
};
const app = productionApp({ fetch: upstream.fetch, share, budget });

const rpc = async (method: string, id: number) =>
  app.request("/v1/rpc/eip155:42170", {
    ...post(call(method, [], id)),
    headers: headers({ "content-type": "application/json", ...at }),
  });

describe("zero-cost dRPC methods bypass metering entirely", () => {
  it("500 free-method calls all reach lb.drpc.live with no share keys and no budget takes", async () => {
    const calls = ["eth_chainId", "net_version", "web3_clientVersion"]
      .flatMap((method) => Array.from({ length: 167 }, () => method))
      .slice(0, 500);
    const statuses: number[] = [];
    for (const [i, method] of calls.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const res = await rpc(method, i + 1);
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      statuses.push(res.status);
    }
    const drpcCalls = upstream.callsTo("https://lb.drpc.live").length;
    const drpcKeys = share.keys.filter((key) => key.startsWith("drpc:"));
    const drpcTakes = takes.filter((take) => take.account === "drpc");
    console.log(
      `free methods: statuses=${JSON.stringify(counts(statuses))} lb.drpc.live-calls=${String(drpcCalls)} ` +
        `share drpc: keys=${String(drpcKeys.length)} budget drpc takes=${String(drpcTakes.length)}`,
    );
    expect(drpcCalls).toBe(500);
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(drpcKeys).toHaveLength(0);
    expect(drpcTakes).toHaveLength(0);
  });

  it("control: priced eth_blockNumber IS share-metered and budget-taken", async () => {
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const res = await rpc("eth_blockNumber", 1000 + i);
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      expect(res.status).toBe(200);
    }
    const drpcKeys = share.keys.filter((key) => key.startsWith("drpc:"));
    const drpcTakes = takes.filter((take) => take.account === "drpc");
    console.log(
      `priced control: share drpc: keys=${String(drpcKeys.length)} deltas=${JSON.stringify(share.deltas.slice(-5))} ` +
        `budget drpc takes=${String(drpcTakes.length)}`,
    );
    expect(drpcKeys.length).toBeGreaterThan(0);
    expect(drpcTakes.length).toBeGreaterThan(0);
  });
});
