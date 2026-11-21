import type { Account, BudgetWindow } from "../config/accounts.ts";
import type { BudgetDecision, ProviderBudget } from "../types.ts";
import type { LeaseResult } from "./durable.ts";

/** The `lease` RPC one account's Durable Object serves. */
export type BudgetStub = {
  lease: (windows: ReadonlyArray<BudgetWindow>, want: number, min: number) => Promise<LeaseResult>;
};

/** The slice of `env.PROVIDER_BUDGET` the port uses — a namespace of per-account objects. */
export type BudgetNamespace = {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => BudgetStub;
};

type Lease = {
  /** Units this isolate may still spend without asking the object again. */
  remaining: number;
  /** Unix ms at which the lease dies; a dead lease's remainder is discarded. */
  expiresAt: number;
  /** Units actually spent under this lease — the next lease's `want` baseline. */
  spent: number;
};

const LEASE_TTL_MS = 1000;
/** A lease asks for at most this fraction of the tightest window's capacity per second. */
const LEASE_FRACTION = 0.01;

const tightest = (windows: ReadonlyArray<BudgetWindow>): BudgetWindow => {
  const [first] = windows;
  let best = first;
  if (best === undefined) {
    throw new Error("provider account has no budget windows");
  }
  for (const window of windows) {
    if (window.units / window.seconds < best.units / best.seconds) {
      best = window;
    }
  }
  return best;
};

/**
 * The production budget port over `env.PROVIDER_BUDGET`. A Durable Object sits ~one round trip away
 * and has a ~1,000 rpc/s soft limit
 * (https://developers.cloudflare.com/durable-objects/platform/limits/), so each isolate keeps a
 * one-second lease per account: an idle isolate takes exactly what it spends, a busy one amortises
 * by asking for at least what it spent under the previous lease, capped at 1 % of the tightest
 * window's capacity. A grant replaces the lease — a discarded remainder only ever under-spends the
 * shared account. A failed object call fails closed with a one-second wait.
 */
export function durableBudget(
  namespace: BudgetNamespace,
  accounts: Readonly<Record<string, Account>>,
  now: () => number,
  log: (line: string) => void,
): ProviderBudget {
  const leases = new Map<string, Lease>();
  const flights = new Map<string, Promise<LeaseResult>>();

  const lease = async (
    account: string,
    windows: ReadonlyArray<BudgetWindow>,
    units: number,
  ): Promise<LeaseResult> => {
    const existing = flights.get(account);
    if (existing !== undefined) {
      return existing;
    }
    const flight = (async (): Promise<LeaseResult> => {
      const spent = leases.get(account)?.spent ?? 0;
      const cap = Math.max(units, Math.ceil(tightest(windows).units * LEASE_FRACTION));
      const want = Math.min(Math.max(units, spent), cap);
      let result: LeaseResult;
      try {
        result = await namespace.get(namespace.idFromName(account)).lease(windows, want, units);
      } catch (error) {
        log(
          JSON.stringify({
            event: "budget-error",
            account,
            reason: error instanceof Error ? error.message : "error",
          }),
        );
        // The shared quota cannot be consulted; refuse rather than overspend it.
        return { ok: false, retryAfterSeconds: 1 };
      }
      if (result.ok) {
        leases.set(account, {
          remaining: result.granted,
          expiresAt: now() + LEASE_TTL_MS,
          spent: 0,
        });
      }
      return result;
    })();
    flights.set(account, flight);
    try {
      return await flight;
    } finally {
      flights.delete(account);
    }
  };

  const take = async (account: string, units: number): Promise<BudgetDecision> => {
    const found = accounts[account];
    if (found === undefined) {
      throw new Error(`provider account "${account}" is not configured`);
    }
    for (;;) {
      const live = leases.get(account);
      if (live !== undefined && live.expiresAt > now() && live.remaining >= units) {
        live.remaining -= units;
        live.spent += units;
        return { ok: true };
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- each pass spends or joins one lease flight
      const result = await lease(account, found.budget, units);
      if (!result.ok) {
        return result;
      }
    }
  };
  return { take };
}
