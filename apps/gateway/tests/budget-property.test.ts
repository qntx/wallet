import { array, assert, asyncProperty, integer, record } from "fast-check";
/**
 * Property over the lease layer: several `durableBudget` isolates share one object running the real
 * `grant`. Random bursts, sizes and clock advances must never spend more than the object granted,
 * and grants must stay inside every window's capacity plus continuous refill.
 */
import { describe, expect, it } from "vite-plus/test";

import { fullBuckets, grant } from "../src/budget/bucket.ts";
import type { BucketState } from "../src/budget/bucket.ts";
import type { BudgetStub, BudgetNamespace } from "../src/budget/leased.ts";
import { durableBudget } from "../src/budget/leased.ts";
import type { Account, BudgetWindow } from "../src/config/accounts.ts";

const ACCOUNT: Account = {
  costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
  budget: [
    { units: 50, seconds: 5 },
    { units: 400, seconds: 60 },
  ],
  clientShare: 0.05,
  source: "https://test.invalid",
};

const FLOAT_SLACK = 1e-9;

const run = async (
  isolateCount: number,
  steps: ReadonlyArray<{
    readonly isolate: number;
    readonly units: number;
    readonly burst: number;
    readonly advance: number;
  }>,
): Promise<void> => {
  let at = 0;
  const states = new Map<string, BucketState>();
  let granted = 0;
  let spent = 0;
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown): BudgetStub => {
      const account = id as string;
      return {
        lease: async (windows: ReadonlyArray<BudgetWindow>, want: number, min: number) => {
          await Promise.resolve();
          const state = states.get(account) ?? fullBuckets(windows, at);
          states.set(account, state);
          const result = grant(windows, state, at, want, min);
          if (result.ok) {
            granted += result.granted;
          }
          return result;
        },
      };
    },
  } as unknown as BudgetNamespace;
  const accounts = { test: ACCOUNT };
  const budgets = Array.from({ length: isolateCount }, () =>
    durableBudget(
      namespace,
      accounts,
      () => at,
      () => undefined,
    ),
  );
  for (const step of steps) {
    at += step.advance;
    const budget = budgets[step.isolate % isolateCount];
    if (budget === undefined) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- one burst per step, steps sequential
    const results = await Promise.all(
      Array.from({ length: step.burst }, async () => budget.take("test", step.units)),
    );
    for (const result of results) {
      if (result.ok) {
        spent += step.units;
      }
    }
  }
  expect(spent).toBeLessThanOrEqual(granted);
  for (const window of ACCOUNT.budget) {
    // `grant` refills incrementally, one rate × elapsed term per lease, so the granted total drifts
    // from this closed-form bound by float rounding (~1e-14 units), far below any real over-grant.
    expect(granted).toBeLessThanOrEqual(
      window.units + (window.units / window.seconds) * (at / 1000) + FLOAT_SLACK,
    );
  }
};

describe("durableBudget lease property", () => {
  it(
    "spends no more than the object grants, and grants stay inside every window",
    { timeout: 60_000 },
    async () => {
      await assert(
        asyncProperty(
          integer({ min: 2, max: 5 }),
          array(
            record({
              isolate: integer({ min: 0, max: 4 }),
              units: integer({ min: 1, max: 60 }),
              burst: integer({ min: 1, max: 4 }),
              advance: integer({ min: 0, max: 1500 }),
            }),
            { minLength: 1, maxLength: 40 },
          ),
          run,
        ),
        {
          numRuns: 200,
          examples: [
            [
              2,
              [
                { isolate: 1, units: 26, burst: 1, advance: 0 },
                { isolate: 0, units: 31, burst: 1, advance: 606 },
                { isolate: 1, units: 1, burst: 1, advance: 742 },
                { isolate: 0, units: 1, burst: 1, advance: 342 },
                { isolate: 0, units: 1, burst: 1, advance: 1 },
                { isolate: 0, units: 1, burst: 1, advance: 4 },
                { isolate: 0, units: 13, burst: 2, advance: 1125 },
                { isolate: 1, units: 1, burst: 1, advance: 556 },
              ],
            ],
          ],
        },
      );
    },
  );
});
