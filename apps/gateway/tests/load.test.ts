import { describe, expect, it } from "vite-plus/test";

import { ALCHEMY_COSTS } from "../src/budget/costs.ts";
import { localBudget } from "../src/budget/local.ts";
import type { Account } from "../src/config/accounts.ts";
import type { RateLimiter } from "../src/types.ts";
import type { UpstreamCall } from "./helpers.ts";
import { TEST_ACCOUNTS, call, gateway, post } from "./helpers.ts";

/**
 * The load scenario the review demonstrated: dozens of rotating client identities spread over many
 * IP prefixes must not be able to make the provider throttle the gateway's shared account or to
 * open a breaker everyone shares.
 *
 * The "upstream" here simulates Alchemy's documented account semantics independently of the
 * gateway's own tables: a token bucket holding `LIMIT × 10` throughput compute units, refilled at
 * `LIMIT` CU/s, answering HTTP 429 when a request costs more than the bucket holds
 * (https://www.alchemy.com/docs/reference/throughput — account-level, ten-second window).
 */

const LIMIT = 200; // simulated throughput CU/s (production PAYG is 10,000)
const CAPACITY = LIMIT * 10;
/** The gateway's share: 80 % of the simulated limit, as the account rows do. */
const GATEWAY_BUDGET = { units: 320, seconds: 2 };
const SIM_URL = "https://simulated-alchemy.test";

/** The simulator's own price list — deliberately not the gateway's table. */
const SIM_PRICES: Readonly<Record<string, number>> = {
  eth_getLogs: 60,
  eth_call: 26,
  alchemy_getAssetTransfers: 120,
};

const ADDRESS = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const SUBNETS = 40;
const SECONDS = 60;

type Sim = {
  tokens: number;
  at: number;
  denied: number;
  received: Array<{ at: number; cu: number }>;
};

/** One answer shape per simulated method; batches answer entry by entry. */
const simResult = (method: string | undefined): unknown =>
  method === "alchemy_getAssetTransfers" ? { transfers: [] } : method === "eth_getLogs" ? [] : "0x";

/** The simulated Alchemy endpoint: the documented account token bucket, keyed by `now`. */
const simulator = (now: () => number): { sim: Sim; upstream: (call: UpstreamCall) => Response } => {
  const sim: Sim = { tokens: CAPACITY, at: 0, denied: 0, received: [] };
  const upstream = (raw: UpstreamCall): Response => {
    const elapsed = Math.max(0, (now() - sim.at) / 1000);
    sim.at = now();
    sim.tokens = Math.min(CAPACITY, sim.tokens + elapsed * LIMIT);
    const parsed: unknown = JSON.parse(raw.body);
    const entries = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      method?: string;
      id?: number;
    }>;
    const cu = entries.reduce((sum, entry) => sum + (SIM_PRICES[entry.method ?? ""] ?? 10), 0);
    if (cu > sim.tokens) {
      sim.denied += 1;
      return new Response("throughput exceeded", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    sim.tokens -= cu;
    sim.received.push({ at: now(), cu });
    const results = entries.map((entry) => ({
      jsonrpc: "2.0",
      id: entry.id ?? 1,
      result: simResult(entry.method),
    }));
    return Response.json(Array.isArray(parsed) ? results : results[0]);
  };
  return { sim, upstream };
};

/** A `RateLimiter` fake with real windows: counts reset when the clock crosses a period. */
const windowed = (limit: number, periodMs: number, now: () => number): RateLimiter => {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key, delta = 1 }) => {
      await Promise.resolve();
      const bucket = `${key}@${Math.floor(now() / periodMs)}`;
      const used = counts.get(bucket) ?? 0;
      if (used >= limit) {
        return { success: false };
      }
      counts.set(bucket, used + delta);
      return { success: true };
    },
  };
};

/** One request for the crowd: history page every third second, getLogs/call otherwise. */
const crowdRequest = (second: number, subnet: number, seq: number): [string, RequestInit] => {
  const init = {
    ...post({}),
    headers: {
      "x-client-id": seq.toString(16).padStart(32, "0"),
      "cf-connecting-ip": `203.0.${subnet}.7`,
      "content-type": "application/json",
    },
  };
  if (second % 3 === 0) {
    return ["/v1/history/eip155:1", { ...init, body: JSON.stringify({ address: ADDRESS }) }];
  }
  const rpc =
    second % 3 === 1
      ? call("eth_getLogs", [{ address: ADDRESS, fromBlock: "latest", toBlock: "latest" }])
      : call("eth_call", [{ to: ADDRESS }]);
  return ["/v1/rpc/eip155:1", { ...init, body: JSON.stringify(rpc) }];
};

/** The gateway's `fetch` option: every call must name the simulated endpoint. */
const simFetch =
  (upstream: (call: UpstreamCall) => Response) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(SIM_URL)) {
      return Promise.reject(new TypeError(`unexpected upstream ${url}`));
    }
    return Promise.resolve(
      upstream({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        headers: init?.headers,
      }),
    );
  };

const breakerOpened = (lines: ReadonlyArray<string>): boolean =>
  lines.some((line) => line.includes('"breaker"') && line.includes('"open"'));

const refused = (statuses: ReadonlyArray<number>): boolean =>
  statuses.some((status) => status === 503 || status === 429);

/** CU the provider received per ten-second window — the allowance the account budget must bound. */
const cuPerWindow = (received: ReadonlyArray<{ at: number; cu: number }>): number[] => {
  const perWindow = new Map<number, number>();
  for (const { at, cu } of received) {
    const bucket = Math.floor(at / 10_000);
    perWindow.set(bucket, (perWindow.get(bucket) ?? 0) + cu);
  }
  return [...perWindow.values()];
};

describe("upstream throttling load", () => {
  it("no client crowd makes the provider answer 429 or opens a breaker", async () => {
    let clock = 0;
    const now = () => clock;
    const { sim, upstream } = simulator(now);

    const accounts: Readonly<Record<string, Account>> = {
      ...TEST_ACCOUNTS,
      alchemy: { costs: ALCHEMY_COSTS, budget: [GATEWAY_BUDGET] },
    };
    const lines: string[] = [];
    const app = gateway({
      fetch: simFetch(upstream),
      networks: [
        {
          id: "eip155:1",
          providers: [{ id: "alchemy", url: SIM_URL }],
        },
      ],
      accounts,
      budget: localBudget(accounts, now),
      limiters: {
        ip: windowed(300, 10_000, now),
        rpc: windowed(100, 10_000, now),
        default: windowed(50, 10_000, now),
        share: windowed(1000, 60_000, now),
      },
      log: (line) => lines.push(line),
      now,
    });

    // `SECONDS` simulated seconds × `SUBNETS` subnets × one request each — every request carries
    // a fresh client id on a rotating /24, the crowd the review's PoC built.
    const statuses: number[] = [];
    for (let second = 0; second < SECONDS; second += 1) {
      const wave = Array.from({ length: SUBNETS }, (_, subnet) =>
        crowdRequest(second, subnet, second * SUBNETS + subnet),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- each simulated second's wave, then the clock
      const responses = await Promise.all(wave.map(async ([path, req]) => app.request(path, req)));
      statuses.push(...responses.map((res) => res.status));
      clock += 1000;
    }

    // The account's own quota — never the provider — absorbed the crowd.
    expect(sim.denied).toBe(0);
    expect(breakerOpened(lines)).toBe(false);
    expect(statuses).toContain(200);
    expect(refused(statuses)).toBe(true);

    // Nothing the gateway forwarded ever exceeded the provider's window allowance: the account
    // budget's capacity plus ten seconds of refill stays inside the simulated ten-second window.
    for (const cu of cuPerWindow(sim.received)) {
      expect(cu).toBeLessThanOrEqual(CAPACITY);
    }
  });
});
