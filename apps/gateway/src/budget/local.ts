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
      const limits = {
        rate: found.rate,
        ...(found.cap === undefined ? {} : { cap: found.cap }),
      };
      let state = states.get(account);
      if (state === undefined) {
        state = fullBuckets(limits, now());
        states.set(account, state);
      }
      const result = grant(limits, state, now(), units, units);
      return result.ok ? { ok: true } : result;
    },
  };
}
