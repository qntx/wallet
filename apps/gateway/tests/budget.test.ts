import { describe, expect, it } from "vite-plus/test";

import { PROVIDERS_HEADER } from "@qntx/wallet-engine/gateway/contract";

import { fullBuckets, grant } from "../src/budget/bucket.ts";
import type { BucketState } from "../src/budget/bucket.ts";
import { ProviderBudgetObject } from "../src/budget/durable.ts";
import { durableBudget } from "../src/budget/leased.ts";
import type { BudgetStub, BudgetNamespace } from "../src/budget/leased.ts";
import { localBudget } from "../src/budget/local.ts";
import type { Account } from "../src/config/accounts.ts";
import type { ProviderBudget } from "../src/types.ts";
import { SEPOLIA, allowAll, call, fakeFetch, gateway, post, rpcOk } from "./helpers.ts";

const seconds = (n: number): { units: number; seconds: number } => ({ units: n, seconds: n });

const breakerOpened = (lines: ReadonlyArray<string>): boolean =>
  lines.some((line) => line.includes('"breaker"') && line.includes('"open"'));

describe("bucket", () => {
  const windows = [{ units: 100, seconds: 10 }, seconds(20)];

  it("starts full and grants up to the smallest level", () => {
    const state = fullBuckets(windows, 0);
    const first = grant(windows, state, 0, 50, 10);
    expect(first).toStrictEqual({ ok: true, granted: 20 });
    expect(state.levels).toStrictEqual([80, 0]);
    const second = grant(windows, state, 0, 50, 1);
    expect(second).toStrictEqual({ ok: false, retryAfterSeconds: 1 });
    expect(state.levels).toStrictEqual([80, 0]);
  });

  it("refills continuously and clamps at capacity", () => {
    const state: BucketState = { levels: [0, 0], at: 0 };
    // After 5 s: window 1 holds 50, window 2 holds 5 — the grant is the smallest level.
    expect(grant(windows, state, 5000, 60, 5)).toStrictEqual({ ok: true, granted: 5 });
    expect(state.levels).toStrictEqual([45, 0]);
    // A minute later the levels refill to capacity, not beyond.
    expect(grant(windows, state, 65_000, 1, 1)).toStrictEqual({ ok: true, granted: 1 });
    expect(state.levels).toStrictEqual([99, 19]);
  });

  it("reports the wait until the tightest window reaches min again", () => {
    // levels [0, 5]: window 1 needs 10 more at 10/s → 1 s; window 2 needs 5 more at 1/s → 5 s.
    const state: BucketState = { levels: [0, 5], at: 0 };
    expect(grant(windows, state, 0, 50, 10)).toStrictEqual({ ok: false, retryAfterSeconds: 5 });
  });

  it("never grants a min above capacity, but still answers a finite wait", () => {
    const state = fullBuckets(windows, 0);
    const result = grant(windows, state, 0, 500, 200);
    expect(result.ok).toBe(false);
    expect(result).toStrictEqual({ ok: false, retryAfterSeconds: expect.any(Number) });
  });
});

describe("localBudget", () => {
  const accounts: Readonly<Record<string, Account>> = {
    test: {
      costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
      budget: [{ units: 10, seconds: 10 }],
      clientShare: 0.05,
    },
  };

  it("grants until the shared quota is spent, then refills with the clock", async () => {
    let at = 0;
    const budget = localBudget(accounts, () => at);
    await expect(budget.take("test", 10)).resolves.toStrictEqual({ ok: true });
    const refused = await budget.take("test", 1);
    expect(refused.ok).toBe(false);
    at = 10_000;
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
  });

  it("rejects an unconfigured account", async () => {
    const budget = localBudget(accounts, () => 0);
    await expect(budget.take("nope", 1)).rejects.toThrow('account "nope"');
  });
});

describe("ProviderBudgetObject", () => {
  // A minimal DurableObjectState: a Map standing in for the sync KV, pass-through concurrency.
  const state = (kv: Map<string, unknown>): DurableObjectState =>
    ({
      storage: {
        kv: {
          get: (key: string) => kv.get(key),
          put: (key: string, value: unknown) => {
            kv.set(key, value);
          },
        },
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    }) as unknown as DurableObjectState;

  const object = (kv: Map<string, unknown>): ProviderBudgetObject =>
    new ProviderBudgetObject(state(kv), {});

  it("grants until the windows are spent and persists the levels across instances", async () => {
    const kv = new Map<string, unknown>();
    const windows = [{ units: 10, seconds: 10 }];
    await expect(object(kv).lease(windows, 10, 5)).resolves.toStrictEqual({
      ok: true,
      granted: 10,
    });
    // A freshly constructed object over the same storage (an evicted one re-instantiated) sees
    // the spent levels — it does not reset to full.
    const refused = await object(kv).lease(windows, 5, 5);
    expect(refused.ok).toBe(false);
  });
});

describe("durableBudget", () => {
  const accounts: Readonly<Record<string, Account>> = {
    test: {
      costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
      budget: [{ units: 1000, seconds: 60 }],
      clientShare: 0.05,
    },
  };

  // The string id stands in for a real DurableObjectId — the port only passes it through.
  const namespace = (stub: BudgetStub, calls: number[]): BudgetNamespace =>
    ({
      idFromName: (name: string) => name,
      get: () => {
        calls.push(1);
        return stub;
      },
    }) as unknown as BudgetNamespace;

  it("leases headroom from the previous lease's spend and re-leases after expiry", async () => {
    const calls: number[] = [];
    const wants: number[] = [];
    const stub: BudgetStub = {
      lease: async (_windows, want, _min) => {
        await Promise.resolve();
        wants.push(want);
        return { ok: true, granted: want };
      },
    };
    let at = 0;
    const budget = durableBudget(
      namespace(stub, calls),
      accounts,
      () => at,
      () => undefined,
    );
    // The first lease grants exactly the take; what it spent becomes the next ask's headroom.
    await expect(budget.take("test", 3)).resolves.toStrictEqual({ ok: true });
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(wants).toStrictEqual([3, 3]);
    // The live lease's remainder (granted 3, spent 1) serves smaller takes without another call.
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(2);
    // Past the lease TTL the isolate asks again — for what it actually spent.
    at = 2000;
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(wants).toStrictEqual([3, 3, 3]);
  });

  it("fails closed when the object call throws, once per flight", async () => {
    const calls: number[] = [];
    const stub: BudgetStub = {
      lease: async () => {
        await Promise.resolve();
        throw new Error("object unreachable");
      },
    };
    const lines: string[] = [];
    const budget = durableBudget(
      namespace(stub, calls),
      accounts,
      () => 0,
      (line) => lines.push(line),
    );
    const [a, b] = await Promise.all([budget.take("test", 1), budget.take("test", 1)]);
    expect(a).toStrictEqual({ ok: false, retryAfterSeconds: 1 });
    expect(b).toStrictEqual({ ok: false, retryAfterSeconds: 1 });
    expect(calls).toHaveLength(1);
    expect(lines.some((line) => line.includes('"budget-error"'))).toBe(true);
  });
});

describe("account budget through the forwarder", () => {
  const refusing = (accounts: Readonly<Record<string, number>>): ProviderBudget => ({
    take: async (account) => {
      await Promise.resolve();
      const wait = accounts[account];
      return wait === undefined ? { ok: true } : { ok: false, retryAfterSeconds: wait };
    },
  });

  it("fails over without fetching when the first provider's account is spent", async () => {
    const upstream = fakeFetch({
      "https://a.test": () => rpcOk("0x1"),
      "https://b.test": () => rpcOk("0x1"),
    });
    const app = gateway({ fetch: upstream.fetch, budget: refusing({ a: 7 }) });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    expect(upstream.callsTo("https://a.test")).toHaveLength(0);
    expect(upstream.callsTo("https://b.test")).toHaveLength(1);
  });

  it("fails a broadcast over when the first account is spent", async () => {
    const upstream = fakeFetch({
      "https://a.test": () => rpcOk("0xabc"),
      "https://b.test": () => rpcOk("0xabc"),
    });
    const app = gateway({ fetch: upstream.fetch, budget: refusing({ a: 7 }) });
    const res = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", ["0xdeadbeef"])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    expect(upstream.callsTo("https://a.test")).toHaveLength(0);
  });

  it("answers 503 with the smallest announced wait when every account is spent", async () => {
    const upstream = fakeFetch({
      "https://a.test": () => rpcOk("0x1"),
      "https://b.test": () => rpcOk("0x1"),
    });
    const app = gateway({ fetch: upstream.fetch, budget: refusing({ a: 7, b: 3 }) });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toStrictEqual({ error: "unavailable" });
    expect(res.headers.get("retry-after")).toBe("3");
    expect(upstream.calls).toHaveLength(0);
  });

  it("never opens the breaker on budget refusals", async () => {
    const upstream = fakeFetch({ "https://b.test": () => rpcOk("0x1") });
    const lines: string[] = [];
    const app = gateway({
      fetch: upstream.fetch,
      budget: refusing({ a: 7 }),
      log: (line) => lines.push(line),
    });
    for (let i = 0; i < 6; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential requests, breaker state persists
      const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
      expect(res.status).toBe(200);
    }
    expect(breakerOpened(lines)).toBe(false);
    expect(upstream.callsTo("https://a.test")).toHaveLength(0);
    expect(upstream.callsTo("https://b.test")).toHaveLength(6);
  });

  it("charges the client's share even when the account budget refuses", async () => {
    const metered: string[] = [];
    const app = gateway({
      fetch: fakeFetch({ "https://a.test": () => rpcOk("0x1") }).fetch,
      budget: refusing({ a: 7, b: 7 }),
      limiters: {
        ip: allowAll,
        rpc: allowAll,
        default: allowAll,
        share: {
          limit: async ({ key }) => {
            await Promise.resolve();
            metered.push(key);
            return { success: true };
          },
        },
      },
    });
    await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    // Both providers were tried; each share charge happened before its budget refusal.
    expect(metered).toStrictEqual(["a:unknown", "b:unknown"]);
  });
});
