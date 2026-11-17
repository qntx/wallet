import {
  ConsecutiveBreaker,
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
    async run<T>(
      providers: ReadonlyArray<ResolvedProvider>,
      attempt: (provider: ResolvedProvider, signal: AbortSignal) => Promise<T>,
    ): Promise<Forwarded<T>> {
      const from = async (index: number): Promise<Forwarded<T>> => {
        const provider = providers[index];
        if (provider === undefined) {
          throw new GatewayHttpError(503, "unavailable", UNAVAILABLE_RETRY_AFTER_SECONDS);
        }
        try {
          const value = await policyFor(`${provider.id}|${provider.url}`).execute(
            async ({ signal }) => attempt(provider, signal),
          );
          return { value, providerId: provider.id };
        } catch (error) {
          if (error instanceof GatewayHttpError) {
            throw error;
          }
          return from(index + 1);
        }
      };
      return from(0);
    },
  };
}

function makePolicy() {
  return wrap(
    circuitBreaker(handleWhen((error) => !(error instanceof GatewayHttpError)), {
      halfOpenAfter: BREAKER_HALF_OPEN_MS,
      breaker: new ConsecutiveBreaker(BREAKER_FAILURES),
    }),
    timeout(UPSTREAM_TIMEOUT_MS, TimeoutStrategy.Aggressive),
  );
}
