/**
 * Adversarial probes for the gateway review (G-1..G-5). These record the _actual_ behaviour of
 * `main`; where a probe's assertions pin sound behaviour, that is itself the finding (a pass means
 * "behaves this way today", not "this behaviour is right").
 *
 * G-2 (pinned TRON share exhaustion → 429 / budget exhaustion → 503, no failover) is already held
 * by tests/breaker.test.ts — the tests added in integration commit
 * ee06827484e419bae918460781cd5e56d98927e1 — so it is cited, not duplicated, here.
 *
 * G-1: `x-gateway-provider` on a TRON node path — an unknown id, a case-differing id, an empty
 * string, and a 4 KiB value. Records the status, whether any upstream fetch ran, whether the
 * response echoes the pin, and whether the flood/share limiters were charged. G-3: budget Durable
 * Object `lease` throwing — requests fail closed 503, a request inside the cached refusal second
 * never reaches the stub, and the stub is asked again after it expires. G-4: an RPC batch's
 * provider charge is the sum of its method cost rows (Alchemy CU model), one upstream call billing
 * the whole batch — and a max-size batch of the cheapest method. G-5: refusal storm — 200
 * same-second takes after a refused one make one stub call in total.
 */
import { describe, expect, it } from "vite-plus/test";

import { PROVIDERS_HEADER, PROVIDER_PIN_HEADER } from "@qntx/wallet-engine/gateway/contract";

import { durableBudget } from "../../src/budget/leased.ts";
import type { BudgetNamespace, BudgetStub } from "../../src/budget/leased.ts";
import type { Account } from "../../src/config/accounts.ts";
import type { GatewayNetwork, ProviderBudget } from "../../src/types.ts";
import {
  CLIENT_ID,
  SEPOLIA,
  TEST_ACCOUNTS,
  allowAll,
  call,
  fakeFetch,
  gateway,
  headers,
  post,
  recordingLimiter,
} from "../helpers.ts";

const NILE = "tron:3448148188";
const TRON_BASE = `/v1/tron/${NILE}`;
const TRON_NETWORKS: ReadonlyArray<GatewayNetwork> = [
  {
    id: NILE,
    providers: [
      { id: "trongrid", url: "https://a.test/tron" },
      { id: "b", url: "https://b.test/tron" },
    ],
  },
];

/** A request-priced single-provider EVM network for the budget/rpc probes. */
const ALCHEMY_NET: ReadonlyArray<GatewayNetwork> = [
  { id: SEPOLIA, providers: [{ id: "alchemy", url: "https://alchemy.test/evm" }] },
];

const namespace = (stub: BudgetStub, calls: number[]): BudgetNamespace =>
  ({
    idFromName: (name: string) => name,
    get: () => {
      calls.push(1);
      return stub;
    },
  }) as unknown as BudgetNamespace;

describe("G-1: the provider pin on a TRON node path", () => {
  // `needle` is what the response body must not contain: the pin itself where it has characters.
  const cases: ReadonlyArray<{ label: string; value: string; needle: string }> = [
    { label: "unknown id", value: "nobody", needle: "nobody" },
    { label: "case-differing id", value: "TRONGRID", needle: "TRONGRID" },
    { label: "empty string", value: "", needle: "x" },
    { label: "4 KiB value", value: "x".repeat(4096), needle: "x".repeat(4096) },
  ];

  it.each(cases)("rejects a pin of $label", async ({ value, needle }) => {
    const up = fakeFetch({
      "https://a.test/tron": () => Response.json({ chainParameter: [] }),
      "https://b.test/tron": () => Response.json({ chainParameter: [] }),
    });
    const share = recordingLimiter();
    const ip = recordingLimiter();
    const rpc = recordingLimiter();
    const app = gateway({
      fetch: up.fetch,
      networks: TRON_NETWORKS,
      limiters: { ip, rpc, default: allowAll, share },
    });
    const res = await app.request(`${TRON_BASE}/wallet/getchainparameters`, {
      ...post({}),
      headers: headers({ "content-type": "application/json", [PROVIDER_PIN_HEADER]: value }),
    });
    // Observed: every malformed pin is a 400 with no upstream call — including the empty string,
    // which is `=== ""` rather than undefined and so is treated as a pin, not as absent.
    expect(res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
    // The pin never reaches a response header or the error body.
    expect(res.headers.get(PROVIDERS_HEADER)).toBeNull();
    await expect(res.text()).resolves.not.toContain(needle);
    // The provider share meter was never asked — the request died before the forwarder —
    // but the flood limiters still paid their one up-front unit.
    expect(share.keys).toStrictEqual([]);
    expect(ip.deltas).toStrictEqual([1]);
    expect(rpc.keys).toStrictEqual([`${CLIENT_ID}:unknown`]);
    expect(rpc.deltas).toStrictEqual([1]);
  });
});

describe("G-3: a failing budget Durable Object", () => {
  const accounts: Readonly<Record<string, Account>> = { a: TEST_ACCOUNTS["a"]! };

  it("fails closed 503, caches the refusal for one second, then asks again", async () => {
    const calls: number[] = [];
    const stub: BudgetStub = {
      lease: async () => {
        await Promise.resolve();
        throw new Error("object unreachable");
      },
    };
    let at = 0;
    const budget = durableBudget(
      namespace(stub, calls),
      accounts,
      () => at,
      () => undefined,
    );
    const up = fakeFetch({ "https://a.test/evm": () => Response.json({}) });
    const single: ReadonlyArray<GatewayNetwork> = [
      { id: SEPOLIA, providers: [{ id: "a", url: "https://a.test/evm" }] },
    ];
    const app = gateway({ fetch: up.fetch, networks: single, budget });
    const request = async () => app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));

    // Object failure → the request fails closed: 503, no upstream fetch, one-second retry hint.
    const first = await request();
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("1");
    expect(up.calls).toHaveLength(0);
    expect(calls).toHaveLength(1);

    // A request inside the cached refusal second never reaches the stub.
    at = 500;
    const second = await request();
    expect(second.status).toBe(503);
    expect(up.calls).toHaveLength(0);
    expect(calls).toHaveLength(1);

    // After the cached second expires the stub is asked again — and fails closed again.
    at = 1001;
    const third = await request();
    expect(third.status).toBe(503);
    expect(up.calls).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });
});

describe("G-4: an RPC batch bills the sum of its method rows", () => {
  const batchResponse = (count: number): Response =>
    Response.json(
      Array.from({ length: count }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, result: "0x1" })),
    );

  const recordingBudget = (): ProviderBudget & {
    readonly takes: ReadonlyArray<{ account: string; units: number }>;
  } => {
    const takes: Array<{ account: string; units: number }> = [];
    return {
      takes,
      take: async (account, units) => {
        takes.push({ account, units });
        await Promise.resolve();
        return { ok: true };
      },
    };
  };

  it("bills 35 CU for [eth_chainId, eth_blockNumber, eth_getBalance] on one upstream call", async () => {
    const up = fakeFetch({ "https://alchemy.test/evm": () => batchResponse(3) });
    const share = recordingLimiter();
    const budget = recordingBudget();
    const app = gateway({
      fetch: up.fetch,
      networks: ALCHEMY_NET,
      limiters: { ip: allowAll, rpc: allowAll, default: allowAll, share },
      budget,
    });
    const res = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post([
        call("eth_chainId", [], 1),
        call("eth_blockNumber", [], 2),
        call("eth_getBalance", [`0x${"11".repeat(20)}`], 3),
      ]),
    );
    expect(res.status).toBe(200);
    // One upstream HTTP call carried the whole batch — the provider sees 3 calls' worth of CUs.
    expect(up.calls).toHaveLength(1);
    // The provider bill: the sum of the method rows (5 + 10 + 20), not one unit per batch.
    expect(budget.takes).toStrictEqual([{ account: "alchemy", units: 35 }]);
    // The client's share charge is derived from the same 35 units
    // (shareDelta(alchemy, 35) = ceil(35·1000/50_000) = 1).
    expect(share.keys).toStrictEqual(["alchemy:unknown"]);
    expect(share.deltas).toStrictEqual([1]);
  });

  it("bills 100 CU for a max-size batch of the cheapest method", async () => {
    const up = fakeFetch({ "https://alchemy.test/evm": () => batchResponse(20) });
    const share = recordingLimiter();
    const budget = recordingBudget();
    const ip = recordingLimiter();
    const app = gateway({
      fetch: up.fetch,
      networks: ALCHEMY_NET,
      limiters: { ip, rpc: allowAll, default: allowAll, share },
      budget,
    });
    const res = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post(Array.from({ length: 20 }, (_, i) => call("eth_chainId", [], i + 1))),
    );
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    // 20 × eth_chainId's 5-CU row = 100 — the provider bills what it metered, not a flat rate.
    expect(budget.takes).toStrictEqual([{ account: "alchemy", units: 100 }]);
    expect(share.deltas).toStrictEqual([2]);
    // Flood charge: the one up-front unit plus 19 for the batch's remaining calls.
    expect(ip.deltas).toStrictEqual([1, 19]);
  });
});

describe("G-5: a refusal storm still costs one stub call", () => {
  const accounts: Readonly<Record<string, Account>> = { a: TEST_ACCOUNTS["a"]! };

  it("200 same-second takes after a refusal make one lease call in total", async () => {
    const calls: number[] = [];
    const stub: BudgetStub = {
      lease: async () => {
        await Promise.resolve();
        return { ok: false, retryAfterSeconds: 60 };
      },
    };
    let at = 0;
    const budget = durableBudget(
      namespace(stub, calls),
      accounts,
      () => at,
      () => undefined,
    );
    const first = await budget.take("a", 1);
    expect(first).toStrictEqual({ ok: false, retryAfterSeconds: 60 });
    expect(calls).toHaveLength(1);
    // 200 concurrent takes: none passes the flight and the cached refusal — one stub call.
    const storm = await Promise.all(Array.from({ length: 200 }, async () => budget.take("a", 1)));
    expect(storm.every((r) => !r.ok)).toBe(true);
    expect(calls).toHaveLength(1);
    // Sequential takes inside the announced wait are served from the cache too.
    for (let i = 0; i < 200; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential same-second takes
      await budget.take("a", 1);
    }
    expect(calls).toHaveLength(1);
    // Past the announced wait the object is asked again.
    at = 60_001;
    await budget.take("a", 1);
    expect(calls).toHaveLength(2);
  });
});
