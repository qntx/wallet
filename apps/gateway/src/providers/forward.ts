import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  TaskCancelledError,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  timeout,
  wrap,
} from "cockatiel";

import { GatewayHttpError } from "../middleware/errors.ts";
import type { ResolvedProvider } from "../types.ts";

export const UPSTREAM_TIMEOUT_MS = 10_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_HALF_OPEN_MS = 30_000;
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/**
 * An upstream failure the breaker should count: a status the provider owns, a malformed body, or a
 * rejected auth call. `refused` marks the attempts the provider provably never processed — an auth
 * failure where nothing was sent, or a 401/403/429 refusal.
 */
// oxlint-disable-next-line unicorn/custom-error-definition -- a marker type, not a generic Error
export class ProviderFailure extends Error {
  readonly reason: string;
  readonly refused: boolean;

  constructor(reason: string, refused: boolean) {
    super(reason);
    this.name = "ProviderFailure";
    this.reason = reason;
    this.refused = refused;
  }
}

export type Forwarded<T> = { readonly value: T; readonly providerId: string };

export type ForwardOptions = {
  /**
   * The call relays a signed transaction. Retrying it on another provider can broadcast the same
   * transaction twice, so failover is allowed only when the failed attempt provably never reached
   * the provider: its breaker was open, or it refused the call (`ProviderFailure.refused`). Any
   * other failure stops the walk with a 502 outcome-unknown.
   */
  readonly broadcast?: boolean;
};

export type Forwarder = {
  /**
   * Tries `attempt` against each provider in order, skipping any whose breaker is open. A thrown
   * error (transport failure, timeout, bad upstream status or body) moves on to the next provider;
   * a returned value ends the walk. A `GatewayHttpError` thrown by `attempt` is the request's own
   * answer: it is rethrown as-is, never fails over and never counts against the shared breaker.
   * When every provider fails the caller gets a 503.
   */
  run: <T>(
    providers: ReadonlyArray<ResolvedProvider>,
    attempt: (provider: ResolvedProvider, signal: AbortSignal) => Promise<T>,
    options?: ForwardOptions,
  ) => Promise<Forwarded<T>>;
};

/**
 * The failure class of one upstream attempt: a provider-owned reason, a timeout, an open breaker, a
 * request-caused rejection, or a transport error. Logged, never returned to the caller.
 */
const failureReason = (error: unknown): string => {
  if (error instanceof ProviderFailure) {
    return error.reason;
  }
  if (error instanceof TaskCancelledError) {
    return "timeout";
  }
  if (error instanceof BrokenCircuitError) {
    return "breaker-open";
  }
  if (error instanceof GatewayHttpError) {
    return "rejected";
  }
  return "transport";
};

/**
 * Policies are kept per provider id for the life of the isolate, so breaker state accumulates.
 * `log` receives one JSON line per failed attempt, per breaker transition, and once when every
 * provider of a run fails — observability for attacks, quota exhaustion and upstream outages.
 */
export function createForwarder(log: (line: string) => void): Forwarder {
  const policies = new Map<string, ReturnType<typeof makePolicy>>();
  const policyFor = (provider: ResolvedProvider): ReturnType<typeof makePolicy> => {
    const key = `${provider.id}|${provider.url}`;
    const existing = policies.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = makePolicy(log, provider);
    policies.set(key, created);
    return created;
  };

  return {
    async run<T>(
      providers: ReadonlyArray<ResolvedProvider>,
      attempt: (provider: ResolvedProvider, signal: AbortSignal) => Promise<T>,
      options?: ForwardOptions,
    ): Promise<Forwarded<T>> {
      const from = async (index: number): Promise<Forwarded<T>> => {
        const provider = providers[index];
        if (provider === undefined) {
          log(
            JSON.stringify({
              event: "all-providers-failed",
              providers: providers.map((p) => p.id),
            }),
          );
          throw new GatewayHttpError(503, "unavailable", UNAVAILABLE_RETRY_AFTER_SECONDS);
        }
        try {
          const value = await policyFor(provider).execute(async ({ signal }) =>
            attempt(provider, signal),
          );
          return { value, providerId: provider.id };
        } catch (error) {
          log(
            JSON.stringify({
              event: "upstream-failure",
              provider: provider.id,
              upstream: provider.url,
              reason: failureReason(error),
            }),
          );
          if (error instanceof GatewayHttpError) {
            throw error;
          }
          if (
            options?.broadcast === true &&
            !(error instanceof BrokenCircuitError) &&
            !(error instanceof ProviderFailure && error.refused)
          ) {
            // The provider may have relayed the transaction; no other answer is safe to invent.
            throw new GatewayHttpError(502, "outcome-unknown");
          }
          return from(index + 1);
        }
      };
      return from(0);
    },
  };
}

function makePolicy(log: (line: string) => void, provider: ResolvedProvider) {
  const breaker = circuitBreaker(
    handleWhen((error) => !(error instanceof GatewayHttpError)),
    {
      halfOpenAfter: BREAKER_HALF_OPEN_MS,
      breaker: new ConsecutiveBreaker(BREAKER_FAILURES),
    },
  );
  const transition = (state: string) => () =>
    log(
      JSON.stringify({
        event: "breaker",
        provider: provider.id,
        upstream: provider.url,
        state,
      }),
    );
  breaker.onBreak(transition("open"));
  breaker.onHalfOpen(transition("half-open"));
  breaker.onReset(transition("closed"));
  return wrap(
    breaker,
    // abortOnReturn: a streamed Esplora body outlives its attempt and is bounded by its own
    // deadline, so the attempt's signal must not be aborted when execute() returns.
    timeout(UPSTREAM_TIMEOUT_MS, { strategy: TimeoutStrategy.Aggressive, abortOnReturn: false }),
  );
}
