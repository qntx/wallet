import type { Account } from "../config/accounts.ts";
import type { ProviderBudget } from "../types.ts";
import type { BucketState } from "./bucket.ts";
import { fullBuckets, grant } from "./bucket.ts";

/**
 * The budget port implemented exactly, in-isolate: what tests and the load simulation use as the
 * reference for {@link ./durable.ts}. State accumulates per account for the life of the isolate.
 */
export function localBudget(
  accounts: Readonly<Record<string, Account>>,
  now: () => number,
): ProviderBudget {
  const states = new Map<string, BucketState>();
  return {
    take: async (account, units) => {
      const found = accounts[account];
      if (found === undefined) {
        throw new Error(`provider account "${account}" is not configured`);
      }
      await Promise.resolve();
      if (units <= 0) {
        return { ok: true };
      }
      let state = states.get(account);
      if (state === undefined) {
        state = fullBuckets(found.budget, now());
        states.set(account, state);
      }
      const result = grant(found.budget, state, now(), units, units);
      return result.ok ? { ok: true } : result;
    },
  };
}
