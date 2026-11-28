import type { Account, RateWindow } from "../config/accounts.ts";
import type { BudgetDecision, ProviderBudget } from "../types.ts";
import type { BudgetLimits } from "./bucket.ts";
import type { LeaseResult } from "./durable.ts";

/** The `lease` RPC one account's Durable Object serves. */
export type BudgetStub = {
  lease: (limits: BudgetLimits, want: number, min: number) => Promise<LeaseResult>;
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
};

type Refusal = {
  /** Unix ms until which the cached refusal holds. */
  until: number;
  /** Smallest take size the refusal was announced for; smaller takes still ask the object. */
  below: number;
};

/** What this isolate knows about one account: the live lease, the spend rate, the last refusal. */
type AccountState = {
  lease?: Lease;
  /** EWMA of successful spend in units per second. */
  rate: number;
  /** Unix ms of the last rate update. */
  rateAt: number;
  refusal?: Refusal;
};

/** A shared flight's landing: the object's answer and the leader's requested minimum. */
type FlightResult = { readonly result: LeaseResult; readonly min: number };

const LEASE_TTL_MS = 2000;
/** A lease asks for this multiple of the demand it expects to see within its second of life. */
const LEASE_HEADROOM = 1.25;
/** A lease asks for at most this fraction of the tightest window's capacity per second. */
const LEASE_FRACTION = 0.05;
/** The spend rate is an EWMA over roughly the last two seconds. */
const RATE_TAU_MS = 2000;

const tightest = (windows: ReadonlyArray<RateWindow>): RateWindow => {
  const [first] = windows;
  let best = first;
  if (best === undefined) {
    throw new Error("provider account has no rate windows");
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
 * two-second lease per account sized to 1.25× the demand its recent spend rate (an EWMA with a 2 s
 * time constant — a steady r units/s converges to r) projects over that window, capped at 5 % of
 * the tightest window's capacity. A grant replaces the lease — a discarded remainder only ever
 * under-spends the shared account.
 *
 * A refusal is cached negatively for its announced wait: a take at or above the refused size is
 * answered locally, a smaller one still asks the object (and can only lower the cached size, so a
 * follower of a large refused flight loops into its own smaller ask). A failed object call fails
 * closed for one second at below=1 — an overloaded object is not retried by every take.
 */
export function durableBudget(
  namespace: BudgetNamespace,
  accounts: Readonly<Record<string, Account>>,
  now: () => number,
  log: (line: string) => void,
): ProviderBudget {
  const states = new Map<string, AccountState>();
  const flights = new Map<string, Promise<FlightResult>>();

  const stateFor = (account: string): AccountState => {
    const found = states.get(account);
    if (found !== undefined) {
      return found;
    }
    const created: AccountState = { rate: 0, rateAt: now() };
    states.set(account, created);
    return created;
  };

  const recordSpend = (state: AccountState, units: number, at: number): void => {
    state.rate =
      state.rate * Math.exp(-(at - state.rateAt) / RATE_TAU_MS) + units / (RATE_TAU_MS / 1000);
    state.rateAt = at;
  };

  /** Keeps the stricter of two live refusals — the one that covers the smaller takes. */
  const cacheRefusal = (state: AccountState, refusal: Refusal, at: number): void => {
    const existing = state.refusal;
    if (existing !== undefined && existing.until > at && existing.below < refusal.below) {
      return;
    }
    state.refusal = refusal;
  };

  const lease = async (
    account: string,
    limits: BudgetLimits,
    units: number,
    state: AccountState,
  ): Promise<FlightResult> => {
    const existing = flights.get(account);
    if (existing !== undefined) {
      return existing;
    }
    const flight = (async (): Promise<FlightResult> => {
      const at = now();
      const rate = state.rate * Math.exp(-(at - state.rateAt) / RATE_TAU_MS);
      const cap = Math.max(units, Math.ceil(tightest(limits.rate).units * LEASE_FRACTION));
      const want = Math.min(
        Math.max(units, Math.ceil((LEASE_HEADROOM * rate * LEASE_TTL_MS) / 1000)),
        cap,
      );
      let result: LeaseResult;
      try {
        result = await namespace.get(namespace.idFromName(account)).lease(limits, want, units);
      } catch (error) {
        log(
          JSON.stringify({
            event: "budget-error",
            account,
            reason: error instanceof Error ? error.message : "error",
          }),
        );
        // The shared quota cannot be consulted; refuse rather than overspend it — and refuse
        // locally for a second so an overloaded object is not hit by every take.
        cacheRefusal(state, { until: at + 1000, below: 1 }, at);
        return { result: { ok: false, retryAfterSeconds: 1 }, min: units };
      }
      if (result.ok) {
        state.lease = { remaining: result.granted, expiresAt: now() + LEASE_TTL_MS };
        delete state.refusal;
      } else {
        cacheRefusal(state, { until: at + result.retryAfterSeconds * 1000, below: units }, at);
      }
      return { result, min: units };
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
    const state = stateFor(account);
    for (;;) {
      const at = now();
      const { refusal } = state;
      if (refusal !== undefined && refusal.until > at && units >= refusal.below) {
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((refusal.until - at) / 1000)),
        };
      }
      const live = state.lease;
      if (live !== undefined && live.expiresAt > at && live.remaining >= units) {
        live.remaining -= units;
        recordSpend(state, units, at);
        return { ok: true };
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- each pass spends or joins one lease flight
      const landed = await lease(
        account,
        { rate: found.rate, ...(found.cap === undefined ? {} : { cap: found.cap }) },
        units,
        state,
      );
      // A smaller follower of a refused flight is not covered by the refusal — it loops and asks
      // on its own minimum. Every pass either answers or strictly lowers the cached refusal size.
      if (!landed.result.ok && units >= landed.min) {
        return landed.result;
      }
    }
  };
  return { take };
}
