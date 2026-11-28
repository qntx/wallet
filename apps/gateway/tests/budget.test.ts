import { describe, expect, it } from "vite-plus/test";

import { PROVIDERS_HEADER } from "@qntx/wallet-engine/gateway/contract";

import { fullBuckets, grant } from "../src/budget/bucket.ts";
import type { BucketState, BudgetLimits } from "../src/budget/bucket.ts";
import type { CostModel } from "../src/budget/costs.ts";
import {
  ALCHEMY_COSTS,
  TRONGRID_COSTS,
  probeCost,
  requestCost,
  rpcCost,
  tronCost,
} from "../src/budget/costs.ts";
import { ProviderBudgetObject } from "../src/budget/durable.ts";
import { durableBudget } from "../src/budget/leased.ts";
import type { BudgetStub, BudgetNamespace } from "../src/budget/leased.ts";
import { localBudget } from "../src/budget/local.ts";
import type { Account } from "../src/config/accounts.ts";
import { PRODUCTION_ACCOUNTS } from "../src/config/accounts.ts";
import { sharePerMinute } from "../src/middleware/rate-limit.ts";
import type { ProviderBudget } from "../src/types.ts";
import {
  SEPOLIA,
  TEST_ACCOUNTS,
  allowAll,
  call,
  fakeFetch,
  gateway,
  post,
  rpcOk,
} from "./helpers.ts";

const seconds = (n: number): { units: number; seconds: number } => ({ units: n, seconds: n });

const breakerOpened = (lines: ReadonlyArray<string>): boolean =>
  lines.some((line) => line.includes('"breaker"') && line.includes('"open"'));

describe("bucket", () => {
  const windows = [{ units: 100, seconds: 10 }, seconds(20)];

  it("starts full and grants up to the smallest level", () => {
    const state = fullBuckets({ rate: windows }, 0);
    const first = grant({ rate: windows }, state, 0, 50, 10);
    expect(first).toStrictEqual({ ok: true, granted: 20 });
    expect(state.levels).toStrictEqual([80, 0]);
    const second = grant({ rate: windows }, state, 0, 50, 1);
    expect(second).toStrictEqual({ ok: false, retryAfterSeconds: 1 });
    expect(state.levels).toStrictEqual([80, 0]);
  });

  it("refills continuously and clamps at capacity", () => {
    const state: BucketState = { levels: [0, 0], at: 0, spend: { hours: [], days: [] } };
    // After 5 s: window 1 holds 50, window 2 holds 5 — the grant is the smallest level.
    expect(grant({ rate: windows }, state, 5000, 60, 5)).toStrictEqual({ ok: true, granted: 5 });
    expect(state.levels).toStrictEqual([45, 0]);
    // A minute later the levels refill to capacity, not beyond.
    expect(grant({ rate: windows }, state, 65_000, 1, 1)).toStrictEqual({ ok: true, granted: 1 });
    expect(state.levels).toStrictEqual([99, 19]);
  });

  it("reports the wait until the tightest window reaches min again", () => {
    // levels [0, 5]: window 1 needs 10 more at 10/s → 1 s; window 2 needs 5 more at 1/s → 5 s.
    const state: BucketState = { levels: [0, 5], at: 0, spend: { hours: [], days: [] } };
    expect(grant({ rate: windows }, state, 0, 50, 10)).toStrictEqual({
      ok: false,
      retryAfterSeconds: 5,
    });
  });

  it("never announces a wait below one second, however short the refill", () => {
    // The second window is already above min — its own wait is non-positive; the announced wait
    // is still the tightest window's, floored at one second.
    const state: BucketState = { levels: [0, 20], at: 0, spend: { hours: [], days: [] } };
    const result = grant({ rate: windows }, state, 0, 50, 10);
    expect(result.ok).toBe(false);
    expect(result).toStrictEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("never grants a min above capacity, but still answers a finite wait", () => {
    const state = fullBuckets({ rate: windows }, 0);
    const result = grant({ rate: windows }, state, 0, 500, 200);
    expect(result.ok).toBe(false);
    expect(result).toStrictEqual({ ok: false, retryAfterSeconds: expect.any(Number) });
  });

  it("treats a level absent from persisted state as empty", () => {
    /* A window added after the state was stored holds no level: window 2 starts at zero and the
       announced wait is its refill to min (10 units at 1/s). */
    const state: BucketState = { levels: [50], at: 0, spend: { hours: [], days: [] } };
    expect(grant({ rate: windows }, state, 0, 50, 10)).toStrictEqual({
      ok: false,
      retryAfterSeconds: 10,
    });
    expect(state.levels).toStrictEqual([50, 0]);
  });
});

describe("bucket spend caps", () => {
  const rate = [{ units: 1_000_000, seconds: 1 }];

  it("refuses at the cap with the wait until the spending slot ages out", () => {
    const limits = { rate, cap: { day: 100 } };
    const state = fullBuckets(limits, 0);
    expect(grant(limits, state, 0, 80, 80)).toStrictEqual({ ok: true, granted: 80 });
    // Headroom is 20 — a 30-unit minimum cannot fit. The 80 units sit in hour slot 0 and age out
    // when the checked range (25 slots) no longer reaches them: at hour 25, in 90,000 s.
    const refused = grant(limits, state, 0, 50, 30);
    expect(refused).toStrictEqual({ ok: false, retryAfterSeconds: 90_000 });
  });

  it("clamps a partial grant to the cap headroom", () => {
    const limits = { rate, cap: { day: 100 } };
    const state = fullBuckets(limits, 0);
    expect(grant(limits, state, 0, 80, 80)).toStrictEqual({ ok: true, granted: 80 });
    expect(grant(limits, state, 0, 50, 10)).toStrictEqual({ ok: true, granted: 20 });
    expect(state.spend.hours).toStrictEqual([[0, 100]]);
  });

  it("keeps day and month slots separate", () => {
    const limits = { rate, cap: { day: 100, month: 150 } };
    const state = fullBuckets(limits, 0);
    expect(grant(limits, state, 0, 80, 80)).toStrictEqual({ ok: true, granted: 80 });
    // 25 hours later the day-cap slot has aged out, but the month slot still counts — its
    // headroom of 70 clamps the grant.
    const later = 25 * 3_600_000;
    expect(grant(limits, state, later, 80, 60)).toStrictEqual({ ok: true, granted: 70 });
    expect(state.spend.days).toHaveLength(2);
  });

  it("prunes slots that have aged out of the checked range", () => {
    const limits = { rate, cap: { day: 100 } };
    const state = fullBuckets(limits, 0);
    expect(grant(limits, state, 0, 80, 80).ok).toBe(true);
    const later = 26 * 3_600_000;
    expect(grant(limits, state, later, 80, 80)).toStrictEqual({ ok: true, granted: 80 });
    expect(state.spend.hours).toStrictEqual([[26, 80]]);
  });

  it("answers a finite wait for a minimum above the cap itself", () => {
    const limits = { rate, cap: { day: 100, month: 1000 } };
    const state = fullBuckets(limits, 0);
    expect(grant(limits, state, 0, 200, 200)).toStrictEqual({
      ok: false,
      retryAfterSeconds: 86_400,
    });
    expect(grant(limits, state, 0, 2000, 2000)).toStrictEqual({
      ok: false,
      retryAfterSeconds: 31 * 86_400,
    });
  });

  it("records spend even without a cap, so a deploy that adds one sees it", () => {
    const limits = { rate };
    const state = fullBuckets(limits, 0);
    expect(grant(limits, state, 0, 80, 80)).toStrictEqual({ ok: true, granted: 80 });
    expect(state.spend.hours).toStrictEqual([[0, 80]]);
    expect(state.spend.days).toStrictEqual([[0, 80]]);
    // The same slots then bind an account that gains the cap: 80 of the 100 are already spent.
    const capped = grant({ ...limits, cap: { day: 100 } }, state, 0, 80, 80);
    expect(capped).toStrictEqual({ ok: false, retryAfterSeconds: 90_000 });
  });

  it("reports the slowest constraint's wait when rate and cap both refuse", () => {
    const limits = { rate: [{ units: 10, seconds: 10 }], cap: { day: 100 } };
    // Rate empty (refill to 20 takes 20 s at 1/s); cap headroom 10 < 20 — the 90 units in hour
    // slot 0 age out in 90,000 s, the slower constraint.
    const state: BucketState = { levels: [0], at: 0, spend: { hours: [[0, 90]], days: [] } };
    expect(grant(limits, state, 0, 50, 20)).toStrictEqual({ ok: false, retryAfterSeconds: 90_000 });
  });
});

describe("ProviderBudgetObject spend persistence", () => {
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
    }) as unknown as DurableObjectState;

  const object = (kv: Map<string, unknown>): ProviderBudgetObject =>
    new ProviderBudgetObject(state(kv), {});

  it("keeps the spend when a deploy changes the rate window count", () => {
    const kv = new Map<string, unknown>();
    const cap = { day: 100 };
    const one = { rate: [{ units: 1000, seconds: 10 }], cap };
    expect(object(kv).lease(one, 90, 90)).toStrictEqual({ ok: true, granted: 90 });
    // The deploy adds a rate window: the levels reset full — but the spent cap must survive:
    // headroom is 10, so a minimum of 20 refuses despite the full buckets.
    const two = {
      rate: [
        { units: 1000, seconds: 10 },
        { units: 1000, seconds: 10 },
      ],
      cap,
    };
    expect(object(kv).lease(two, 50, 20).ok).toBe(false);
    expect(object(kv).lease(two, 50, 10)).toStrictEqual({ ok: true, granted: 10 });
    // A state without spend (the pre-cap shape) starts fresh.
    kv.set("levels", { levels: [0], at: 0 });
    expect(object(kv).lease(one, 10, 10)).toStrictEqual({ ok: true, granted: 10 });
  });
});

describe("account validation", () => {
  const valid: Account = {
    costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
    rate: [{ units: 10, seconds: 10 }],
    clientShare: 0.05,
    source: "https://test.invalid",
  };

  it("throws on a rate window longer than a minute", () => {
    expect(() => sharePerMinute({ ...valid, rate: [{ units: 10, seconds: 86_400 }] })).toThrow(
      /86,400|86_400|86400|rate window/,
    );
  });

  it("throws on a non-positive rate window", () => {
    expect(() => sharePerMinute({ ...valid, rate: [{ units: 10, seconds: 0 }] })).toThrow(
      /rate window/,
    );
  });

  it.each([0, -5, 1.5, Number.NaN])("throws on a cap of %s", (cap) => {
    expect(() => sharePerMinute({ ...valid, cap: { day: cap } })).toThrow(/cap/);
    expect(() => sharePerMinute({ ...valid, cap: { month: cap } })).toThrow(/cap/);
  });
});

describe("tron cost model", () => {
  it("prices each path from its row", () => {
    expect(tronCost(TRONGRID_COSTS, "/wallet/getnowblock")).toBe(80);
    expect(tronCost(TRONGRID_COSTS, "/wallet/listwitnesses")).toBe(150);
    expect(tronCost(TRONGRID_COSTS, "/v1/accounts/transactions")).toBe(160);
    expect(tronCost(TRONGRID_COSTS, "/v1/accounts/transactions/trc20")).toBe(200);
    expect(tronCost(TRONGRID_COSTS, "/v1/accounts/account")).toBe(80);
  });

  it("answers the request units for a request-priced provider", () => {
    const model: CostModel = {
      kind: "request",
      request: { units: 5, source: "https://test.invalid" },
    };
    expect(tronCost(model, "/wallet/getnowblock")).toBe(5);
  });

  it("throws for requestCost, rpcCost and probeCost on a tron-priced account", () => {
    expect(() => requestCost(TRONGRID_COSTS)).toThrow(/misconfigured/);
    expect(() => rpcCost(TRONGRID_COSTS, { method: "eth_chainId" })).toThrow(/misconfigured/);
    expect(() => probeCost(TRONGRID_COSTS, "eth_chainId")).toThrow(/misconfigured/);
  });

  it("throws for tronCost on an rpc-priced account", () => {
    expect(() => tronCost(ALCHEMY_COSTS, "/wallet/getnowblock")).toThrow(/misconfigured/);
  });
});

describe("localBudget", () => {
  const accounts: Readonly<Record<string, Account>> = {
    test: {
      costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
      rate: [{ units: 10, seconds: 10 }],
      clientShare: 0.05,
      source: "https://test.invalid",
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
  // A minimal DurableObjectState: a Map standing in for the sync KV.
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
    }) as unknown as DurableObjectState;

  const object = (kv: Map<string, unknown>): ProviderBudgetObject =>
    new ProviderBudgetObject(state(kv), {});

  it("grants until the windows are spent and persists the levels across instances", () => {
    const kv = new Map<string, unknown>();
    const limits = { rate: [{ units: 10, seconds: 10 }] };
    expect(object(kv).lease(limits, 10, 5)).toStrictEqual({
      ok: true,
      granted: 10,
    });
    // A freshly constructed object over the same storage (an evicted one re-instantiated) sees
    // the spent levels — it does not reset to full.
    const refused = object(kv).lease(limits, 5, 5);
    expect(refused.ok).toBe(false);
  });
});

describe("durableBudget", () => {
  const accounts: Readonly<Record<string, Account>> = {
    test: {
      costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
      rate: [{ units: 1000, seconds: 60 }],
      clientShare: 0.05,
      source: "https://test.invalid",
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

  it("sizes each lease from the recent spend rate and re-leases after expiry", async () => {
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
    // The first two asks see spend rates of 0 then 1.5 units/s — headroom rounds up to 3 then 4.
    await expect(budget.take("test", 3)).resolves.toStrictEqual({ ok: true });
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(wants).toStrictEqual([3, 4]);
    // The live lease's remainder (granted 4, spent 1) serves smaller takes without another call.
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(2);
    // Two seconds later the rate has decayed to ~1.1 units/s — the ask shrinks to 3.
    at = 2000;
    await expect(budget.take("test", 1)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(wants).toStrictEqual([3, 4, 3]);
  });

  it("clears a cached refusal when the object grants again", async () => {
    const calls: number[] = [];
    let grantNext = false;
    const stub: BudgetStub = {
      lease: async () => {
        await Promise.resolve();
        // oxlint-disable-next-line vitest/no-conditional-in-test -- the stub flips on the second call
        return grantNext ? { ok: true, granted: 10 } : { ok: false, retryAfterSeconds: 60 };
      },
    };
    const budget = durableBudget(
      namespace(stub, calls),
      accounts,
      () => 0,
      () => undefined,
    );
    // The refused 10-unit take caches a refusal covering takes of 10 and up for a minute.
    await expect(budget.take("test", 10)).resolves.toStrictEqual({
      ok: false,
      retryAfterSeconds: 60,
    });
    // A smaller take is not covered: it flies to the object, which now grants — and the grant
    // must clear the stale refusal, not just fill the lease.
    grantNext = true;
    await expect(budget.take("test", 5)).resolves.toStrictEqual({ ok: true });
    await expect(budget.take("test", 10)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(3);
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

  it("refuses without an upstream call when the budget object throws", async () => {
    const upstream = fakeFetch({
      "https://a.test": () => rpcOk("0x1"),
      "https://b.test": () => rpcOk("0x1"),
    });
    const stub: BudgetStub = {
      lease: async () => {
        await Promise.resolve();
        throw new Error("object unreachable");
      },
    };
    const budget = durableBudget(
      { idFromName: (name: string) => name, get: () => stub } as unknown as BudgetNamespace,
      TEST_ACCOUNTS,
      Date.now,
      () => undefined,
    );
    const app = gateway({ fetch: upstream.fetch, budget });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(503);
    expect(upstream.calls).toHaveLength(0);
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

describe("durableBudget lease amortisation", () => {
  const roomy: Readonly<Record<string, Account>> = {
    test: {
      costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
      rate: [{ units: 100_000, seconds: 5 }],
      clientShare: 0.05,
      source: "https://test.invalid",
    },
  };

  type LeaseCall = { readonly want: number; readonly min: number };

  /**
   * Fake namespace: one shared BucketState per account, `lease` runs the real `grant` under the
   * fake clock `at` — the oracle is the real bucket math.
   */
  const fakeNamespace = (
    at: () => number,
    options: { readonly seeded?: Record<string, BucketState>; gate?: () => Promise<void> } = {},
  ) => {
    const states = new Map<string, BucketState>();
    const calls: LeaseCall[] = [];
    const namespace = {
      idFromName: (name: string): DurableObjectId => name as unknown as DurableObjectId,
      get: (id: DurableObjectId): BudgetStub => {
        const account = id as unknown as string;
        return {
          lease: async (limits: BudgetLimits, want: number, min: number) => {
            calls.push({ want, min });
            await options.gate?.();
            const state =
              states.get(account) ?? options.seeded?.[account] ?? fullBuckets(limits, at());
            states.set(account, state);
            return grant(limits, state, at(), want, min);
          },
        };
      },
    };
    return { namespace, calls };
  };

  it("amortises a steady load into about one lease call per second", async () => {
    let at = 0;
    const { namespace, calls } = fakeNamespace(() => at);
    const { take } = durableBudget(
      namespace,
      PRODUCTION_ACCOUNTS,
      () => at,
      () => undefined,
    );
    // 26-unit takes at ten per second for ten seconds — inside alchemy's 40,000/5 s window.
    for (let i = 0; i < 100; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const result = await take("alchemy", 26);
      expect(result.ok).toBe(true);
      at += 100;
    }
    // The converged ask is ceil(1.25 × 260 units/s × 2 s) = 650 units (25 takes per grant), so
    // the deterministic count lands at ~0.5/s steady plus the two-second rate ramp.
    expect(calls.length).toBeLessThanOrEqual(10);
  });

  it("answers a refusal storm from the negative cache", async () => {
    let at = 0;
    const { namespace, calls } = fakeNamespace(() => at, {
      seeded: { alchemy: { levels: [0], at: 0, spend: { hours: [], days: [] } } },
    });
    const { take } = durableBudget(
      namespace,
      PRODUCTION_ACCOUNTS,
      () => at,
      () => undefined,
    );
    let announced = 0;
    for (let i = 0; i < 50; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const result = await take("alchemy", 26);
      expect(result.ok).toBe(false);
      // oxlint-disable-next-line vitest/no-conditional-in-test -- collect the announced wait
      announced = Math.max(announced, result.ok ? 0 : result.retryAfterSeconds);
      at += 20;
    }
    // Fifty refusals in under a second cost the object one call.
    expect(calls).toHaveLength(1);
    expect(announced).toBeGreaterThan(0);
    at += announced * 1000;
    // Past the announced wait the isolate asks again.
    await take("alchemy", 26);
    expect(calls).toHaveLength(2);
  });

  it("lets a smaller take ask again after joining a refused flight", async () => {
    const at = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const { namespace, calls } = fakeNamespace(() => at, {
      seeded: { alchemy: { levels: [100], at: 0, spend: { hours: [], days: [] } } },
      gate: async () => gate,
    });
    const { take } = durableBudget(
      namespace,
      PRODUCTION_ACCOUNTS,
      () => at,
      () => undefined,
    );
    const big = take("alchemy", 500);
    const small = take("alchemy", 26);
    release();
    const [bigResult, smallResult] = await Promise.all([big, small]);
    expect(bigResult.ok).toBe(false);
    // The refused 500-unit flight does not cover a 26-unit take — it asks on its own.
    expect(smallResult).toStrictEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("refuses locally for a second after the object call fails", async () => {
    let at = 0;
    const calls: number[] = [];
    const stub: BudgetStub = {
      lease: async () => {
        calls.push(1);
        await Promise.resolve();
        throw new Error("object unreachable");
      },
    };
    const { take } = durableBudget(
      {
        idFromName: (name: string) => name,
        get: () => stub,
      } as unknown as BudgetNamespace,
      PRODUCTION_ACCOUNTS,
      () => at,
      () => undefined,
    );
    await expect(take("alchemy", 26)).resolves.toStrictEqual({
      ok: false,
      retryAfterSeconds: 1,
    });
    // The failure caches below=1 — even the smallest take is refused without a call.
    await expect(take("alchemy", 1)).resolves.toStrictEqual({
      ok: false,
      retryAfterSeconds: 1,
    });
    expect(calls).toHaveLength(1);
    at += 1000;
    await take("alchemy", 1);
    expect(calls).toHaveLength(2);
  });

  it("never spends a lease that is dead or smaller than the take", async () => {
    let at = 0;
    const { namespace, calls } = fakeNamespace(() => at);
    const { take } = durableBudget(
      namespace,
      roomy,
      () => at,
      () => undefined,
    );
    await expect(take("test", 20)).resolves.toStrictEqual({ ok: true });
    await expect(take("test", 20)).resolves.toStrictEqual({ ok: true });
    // Rate-based ask of 50 leaves a remainder of 40 after this take.
    await expect(take("test", 10)).resolves.toStrictEqual({ ok: true });
    expect(calls.map((call) => call.min)).toStrictEqual([20, 20, 10]);
    // The live lease's 40 cannot pay 45 — a fresh call, not a partial spend.
    await expect(take("test", 45)).resolves.toStrictEqual({ ok: true });
    expect(calls.map((call) => call.min)).toStrictEqual([20, 20, 10, 45]);
    // Past the lease's two seconds of life its remainder is discarded, never spent.
    at += 2500;
    await expect(take("test", 5)).resolves.toStrictEqual({ ok: true });
    expect(calls).toHaveLength(5);
  });

  it("caps a lease ask at five percent of the tightest window under high load", async () => {
    const at = 0;
    const { namespace, calls } = fakeNamespace(() => at);
    const { take } = durableBudget(
      namespace,
      PRODUCTION_ACCOUNTS,
      () => at,
      () => undefined,
    );
    // Two hundred takes at one instant push the measured rate far past any real traffic.
    for (let i = 0; i < 200; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const result = await take("alchemy", 26);
      expect(result.ok).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(1);
    // alchemy's tightest window is 36,000 units — the ask never exceeds 1,800.
    expect(Math.max(...calls.map((call) => call.want))).toBeLessThanOrEqual(1800);
    expect(calls.some((call) => call.want === 1800)).toBe(true);
  });
});
