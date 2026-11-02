import {
  ConsecutiveBreaker,
  TimeoutStrategy,
  circuitBreaker,
  handleAll,
  timeout,
  wrap,
} from "cockatiel";

import { GatewayHttpError } from "../middleware/errors.ts";
import type { UpstreamProvider } from "../types.ts";

export const UPSTREAM_TIMEOUT_MS = 10_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_HALF_OPEN_MS = 30_000;
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

export type Forwarded<T> = { readonly value: T; readonly providerId: string };

export type Forwarder = {
  /**
   * Tries `attempt` against each provider in order, skipping any whose breaker is open. A thrown
   * error (transport failure, timeout, bad upstream status or body) moves on to the next provider;
   * a returned value ends the walk. When every provider fails the caller gets a 503.
   */
  run: <T>(
    providers: ReadonlyArray<UpstreamProvider>,
    attempt: (provider: UpstreamProvider, signal: AbortSignal) => Promise<T>,
  ) => Promise<Forwarded<T>>;
};

/** Policies are kept per provider id for the life of the isolate, so breaker state accumulates. */
export function createForwarder(): Forwarder {
  const policies = new Map<string, ReturnType<typeof makePolicy>>();
  const policyFor = (id: string): ReturnType<typeof makePolicy> => {
    const existing = policies.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created = makePolicy();
    policies.set(id, created);
    return created;
  };

  return {
    async run(providers, attempt) {
      const from = async (index: number) => {
        const provider = providers[index];
        if (provider === undefined) {
          throw new GatewayHttpError(503, "unavailable", UNAVAILABLE_RETRY_AFTER_SECONDS);
        }
        try {
          const value = await policyFor(`${provider.id}|${provider.url}`).execute(
            async ({ signal }) => attempt(provider, signal),
          );
          return { value, providerId: provider.id };
        } catch {
          return from(index + 1);
        }
      };
      return from(0);
    },
  };
}

function makePolicy() {
  return wrap(
    circuitBreaker(handleAll, {
      halfOpenAfter: BREAKER_HALF_OPEN_MS,
      breaker: new ConsecutiveBreaker(BREAKER_FAILURES),
    }),
    timeout(UPSTREAM_TIMEOUT_MS, TimeoutStrategy.Aggressive),
  );
}
