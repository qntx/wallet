/**
 * `durableBudget` over a fake DO namespace whose stub `lease` runs the real `grant` on one shared
 * `BucketState` (the oracle is the real bucket math). Documents three properties: a lease never
 * grows past one request's cost so amortisation is ~1 DO call per spend; a single-flight refusal is
 * shared by unrelated concurrent callers (a 26-unit take joins a 500-unit flight and is refused
 * although the bucket holds 100); and every refusal is still a DO round trip — a refusal storm is
 * not free.
 */
import { describe, expect, it } from "vite-plus/test";

import type { BucketState } from "../../src/budget/bucket.ts";
import { fullBuckets, grant } from "../../src/budget/bucket.ts";
import type { BudgetStub } from "../../src/budget/leased.ts";
import { durableBudget } from "../../src/budget/leased.ts";
import type { BudgetWindow } from "../../src/config/accounts.ts";
import { PRODUCTION_ACCOUNTS } from "../../src/config/accounts.ts";

const NOW = 1_795_200_000_000;
const now = () => NOW;

type LeaseCall = { readonly account: string; readonly want: number; readonly min: number };

/** Fake namespace: one shared BucketState per account, `lease` = the real `grant`. */
const fakeNamespace = (
  options: { readonly seeded?: Record<string, BucketState>; gate?: () => Promise<void> } = {},
) => {
  const states = new Map<string, BucketState>();
  const calls: LeaseCall[] = [];
  const namespace = {
    idFromName: (name: string): DurableObjectId => name as unknown as DurableObjectId,
    get: (id: DurableObjectId): BudgetStub => {
      const account = id as unknown as string;
      return {
        lease: async (windows: ReadonlyArray<BudgetWindow>, want: number, min: number) => {
          calls.push({ account, want, min });
          await options.gate?.();
          const state =
            states.get(account) ?? options.seeded?.[account] ?? fullBuckets(windows, now());
          states.set(account, state);
          return grant(windows, state, now(), want, min);
        },
      };
    },
  };
  return { namespace, calls, states };
};

const budget = (namespace: ReturnType<typeof fakeNamespace>["namespace"]) =>
  durableBudget(namespace, PRODUCTION_ACCOUNTS, now, () => undefined);

describe("lease sizing", () => {
  it("100 sequential 26-CU takes = 100 lease RPCs (lease never exceeds one request's cost)", async () => {
    const { namespace, calls } = fakeNamespace();
    const { take } = budget(namespace);
    for (let i = 0; i < 100; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const result = await take("alchemy", 26);
      expect(result.ok).toBe(true);
    }
    const wants = calls.map((call) => call.want);
    console.log(
      `sequential: takes=100 lease-rpcs=${String(calls.length)} ` +
        `wants=${JSON.stringify([...new Set(wants)])}`,
    );
    expect(calls).toHaveLength(100);
    expect(new Set(wants)).toStrictEqual(new Set([26]));
  });

  it("a concurrent 26-unit take shares a refused 500-unit flight although 100 units sit in the bucket", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const seeded: Record<string, BucketState> = {
      alchemy: { levels: [100], at: NOW },
    };
    const { namespace, calls } = fakeNamespace({ seeded, gate: async () => gate });
    const { take } = budget(namespace);

    const big = take("alchemy", 500);
    const small = take("alchemy", 26); // joins the in-flight 500-unit lease request
    release();
    const [bigResult, smallResult] = await Promise.all([big, small]);
    const after = await take("alchemy", 26);
    console.log(
      `refusal-sharing: take(500).ok=${String(bigResult.ok)} take(26-joined).ok=${String(smallResult.ok)} ` +
        `take(26-after).ok=${String(after.ok)} lease-rpcs=${String(calls.length)}`,
    );
    expect(bigResult.ok).toBe(false);
    expect(smallResult.ok).toBe(false); // refused although 100 >= 26 were available
    expect(calls).toHaveLength(2); // the joined take made no RPC of its own
    expect(after.ok).toBe(true);
  });

  it("50 sequential takes on a drained bucket = 50 lease RPCs, all refused", async () => {
    const { namespace, calls } = fakeNamespace({
      seeded: { alchemy: { levels: [0], at: NOW } },
    });
    const { take } = budget(namespace);
    let refused = 0;
    for (let i = 0; i < 50; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const result = await take("alchemy", 26);
      refused += Number(!result.ok);
    }
    console.log(`drained: takes=50 lease-rpcs=${String(calls.length)} refused=${String(refused)}`);
    expect(refused).toBe(50);
    expect(calls).toHaveLength(50);
  });
});
