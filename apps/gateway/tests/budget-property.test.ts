// oxlint-disable vitest/no-conditional-in-test -- property runners branch on the generated case
import { array, assert, asyncProperty, integer, property, record } from "fast-check";
/**
 * Properties over the budget math:
 *
 * - Bucket level: random rate windows, caps and step sequences; every recorded grant sequence must
 *   respect the sliding cap invariant (any 24 h / 31 days) and each rate window's bucket bound.
 * - Lease level: several `durableBudget` isolates share one object running the real `grant`; random
 *   bursts, sizes and clock advances must never spend more than the object granted, and grants must
 *   stay inside the caps.
 */
import { describe, expect, it } from "vite-plus/test";

import { fullBuckets, grant } from "../src/budget/bucket.ts";
import type { BucketState, BudgetLimits } from "../src/budget/bucket.ts";
import type { BudgetStub, BudgetNamespace } from "../src/budget/leased.ts";
import { durableBudget } from "../src/budget/leased.ts";
import type { Account, RateWindow } from "../src/config/accounts.ts";

const FLOAT_SLACK = 1e-9;
const DAY_MS = 86_400_000;

const ACCOUNT: Account = {
  costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
  rate: [
    { units: 50, seconds: 5 },
    { units: 400, seconds: 60 },
  ],
  cap: { day: 600, month: 4000 },
  clientShare: 0.05,
  source: "https://test.invalid",
};

/** The summed grants inside every interval `[t - windowMs, t]` ending at a grant, inclusive. */
const worstIntervalSum = (
  grants: ReadonlyArray<readonly [at: number, units: number]>,
  windowMs: number,
): number => {
  let worst = 0;
  for (const [at] of grants) {
    let sum = 0;
    for (const [t, units] of grants) {
      if (t >= at - windowMs && t <= at) {
        sum += units;
      }
    }
    worst = Math.max(worst, sum);
  }
  return worst;
};

/** The cap invariant: no 24 h interval exceeds `day`, no 31-day interval exceeds `month`. */
const expectCapsHeld = (
  grants: ReadonlyArray<readonly [number, number]>,
  cap: { readonly day?: number; readonly month?: number },
): void => {
  if (cap.day !== undefined) {
    expect(worstIntervalSum(grants, DAY_MS)).toBeLessThanOrEqual(cap.day + FLOAT_SLACK);
  }
  if (cap.month !== undefined) {
    expect(worstIntervalSum(grants, 31 * DAY_MS)).toBeLessThanOrEqual(cap.month + FLOAT_SLACK);
  }
};

/** Each rate window's token-bucket bound over every interval ending at a grant. */
const expectRatesHeld = (
  grants: ReadonlyArray<readonly [number, number]>,
  rate: ReadonlyArray<RateWindow>,
): void => {
  for (const window of rate) {
    for (const [at] of grants) {
      for (const length of [1000, 10_000, 60_000, 3_600_000]) {
        let sum = 0;
        for (const [t, units] of grants) {
          if (t >= at - length && t <= at) {
            sum += units;
          }
        }
        // A refill rate of r cannot grant more than capacity + r × length in any interval.
        expect(sum).toBeLessThanOrEqual(
          window.units + (window.units / window.seconds) * (length / 1000) + FLOAT_SLACK,
        );
      }
    }
  }
};

type BucketStep = {
  readonly advance: number;
  readonly want: number;
  readonly min: number;
};

/** Runs one step sequence against `limits`, recording every grant; `seed` replaces the state. */
const runSteps = (
  limits: BudgetLimits,
  steps: ReadonlyArray<BucketStep>,
  mutate?: (state: BucketState, index: number, at: number) => BucketState,
): { readonly grants: Array<readonly [number, number]>; readonly state: BucketState } => {
  let at = 0;
  let state = fullBuckets(limits, at);
  const grants: Array<readonly [number, number]> = [];
  for (const [index, step] of steps.entries()) {
    at += step.advance;
    state = mutate?.(state, index, at) ?? state;
    const result = grant(limits, state, at, step.want, step.min);
    if (result.ok && result.granted > 0) {
      grants.push([at, result.granted]);
    }
  }
  return { grants, state };
};

const smallish = integer({ min: 0, max: 3000 });
/** Clock advances biased towards small steps but reaching three days. */
const advanceMs = integer({ min: 0, max: 100 }).chain((roll) =>
  roll < 70 ? smallish : integer({ min: 0, max: 3 * DAY_MS }),
);

const rateWindows = array(
  record({
    units: integer({ min: 1, max: 500 }),
    seconds: integer({ min: 25, max: 6000 }).map((centi) => centi / 100),
  }),
  { minLength: 1, maxLength: 3 },
);

const spendCap = record(
  {
    day: integer({ min: 50, max: 2000 }),
    month: integer({ min: 200, max: 8000 }),
  },
  { requiredKeys: [] },
);

const bucketSteps = array(
  integer({ min: 1, max: 120 }).chain((want) =>
    record({
      advance: advanceMs,
      want: integer({ min: want, max: want }),
      min: integer({ min: 1, max: want }),
    }),
  ),
  { minLength: 1, maxLength: 60 },
);

describe("bucket property", () => {
  it(
    "grants stay inside the sliding caps and every rate window's bucket bound",
    { timeout: 120_000 },
    () => {
      assert(
        property(rateWindows, spendCap, bucketSteps, (rate, cap, steps) => {
          const hasCap = cap.day !== undefined || cap.month !== undefined;
          const limits: BudgetLimits = { rate, ...(hasCap ? { cap } : {}) };
          const { grants } = runSteps(limits, steps);
          expectCapsHeld(grants, cap);
          expectRatesHeld(grants, rate);
        }),
        { numRuns: 150 },
      );
    },
  );

  it("a deploy-style window-count change resets levels but never refills the caps", () => {
    // Seeded sequence: spend most of the day cap, advance into the hours where the spend still
    // counts, then the rate rows change — the durable object's reset keeps `spend`, and the cap
    // invariant must still hold over the whole sequence.
    const cap = { day: 100, month: 400 };
    const wide: BudgetLimits = { rate: [{ units: 500, seconds: 5 }], cap };
    const narrow: BudgetLimits = {
      rate: [
        { units: 500, seconds: 5 },
        { units: 900, seconds: 30 },
      ],
      cap,
    };
    let at = 0;
    const grants: Array<readonly [number, number]> = [];
    let state = fullBuckets(wide, at);
    const take = (limits: BudgetLimits, advance: number, want: number, min: number): void => {
      at += advance;
      const result = grant(limits, state, at, want, min);
      if (result.ok && result.granted > 0) {
        grants.push([at, result.granted]);
      }
    };
    take(wide, 0, 90, 90);
    take(wide, 60_000, 50, 10);
    let spent = 0;
    for (const [, units] of state.spend.hours) {
      spent += units;
    }
    expect(spent).toBe(100);
    // The deploy: window count 1 → 2. The object resets levels full and KEEPS spend.
    state = { ...fullBuckets(narrow, at), spend: state.spend };
    // Levels are full again, but the cap's headroom is zero — nothing is granted.
    take(narrow, 1000, 50, 1);
    expect(grants).toHaveLength(2);
    // Once the oldest hour slots age out the cap admits again — never beyond it.
    take(narrow, 25 * 3_600_000, 90, 1);
    take(narrow, 60_000, 60, 1);
    expectCapsHeld(grants, cap);
    // The rate windows of the post-deploy shape held from the reset on.
    const postDeploy = grants.slice(2);
    expectRatesHeld(postDeploy, narrow.rate);
  });
});

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
  let grantedTotal = 0;
  let spent = 0;
  const objectGrants: Array<readonly [number, number]> = [];
  const limits: BudgetLimits = {
    rate: ACCOUNT.rate,
    ...(ACCOUNT.cap === undefined ? {} : { cap: ACCOUNT.cap }),
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown): BudgetStub => {
      const account = id as string;
      return {
        lease: async (leaseLimits: BudgetLimits, want: number, min: number) => {
          await Promise.resolve();
          const state = states.get(account) ?? fullBuckets(leaseLimits, at);
          states.set(account, state);
          const result = grant(leaseLimits, state, at, want, min);
          if (result.ok) {
            grantedTotal += result.granted;
            if (result.granted > 0) {
              objectGrants.push([at, result.granted]);
            }
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
  expect(spent).toBeLessThanOrEqual(grantedTotal);
  for (const window of ACCOUNT.rate) {
    // `grant` refills incrementally, one rate × elapsed term per lease, so the granted total drifts
    // from this closed-form bound by float rounding (~1e-14 units), far below any real over-grant.
    expect(grantedTotal).toBeLessThanOrEqual(
      window.units + (window.units / window.seconds) * (at / 1000) + FLOAT_SLACK,
    );
  }
  expectCapsHeld(objectGrants, limits.cap ?? {});
};

describe("durableBudget lease property", () => {
  it(
    "spends no more than the object grants, and grants stay inside windows and caps",
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
              advance: advanceMs,
            }),
            { minLength: 1, maxLength: 40 },
          ),
          run,
        ),
        {
          numRuns: 150,
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
