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
import type { ProviderBudget, ResolvedProvider } from "../types.ts";
import { ResponseTooLarge, readCapped } from "./body.ts";

export const UPSTREAM_TIMEOUT_MS = 10_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_HALF_OPEN_MS = 30_000;
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** Statuses a JSON-RPC upstream answers when the request itself is wrong: the caller's own 400. */
export const REQUEST_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/** Statuses where the provider refused the call before processing it (429 is an outage). */
export const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * A failed attempt the provider answered: a refusal (401/403, `refused`), a malformed body, an
 * upstream JSON-RPC error, or a status the attempt does not serve. The walk fails over, but the
 * breaker never counts it — every such answer is one a client can provoke with its own input.
 */
// oxlint-disable-next-line unicorn/custom-error-definition -- a marker type, not a generic Error
export class ProviderFailure extends Error {
  readonly reason: string;
  readonly refused: boolean;
  /** How long the caller should wait, when the failure is a spent budget or a cool-down. */
  readonly retryAfterSeconds: number | undefined;

  constructor(reason: string, refused: boolean, retryAfterSeconds?: number) {
    super(reason);
    this.name = "ProviderFailure";
    this.reason = reason;
    this.refused = refused;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A provider-wide failure observed by {@link Send}: transport, 5xx, 429, or a failed auth lookup.
 * Only `send` constructs it and only it (and the attempt timeout) counts against the breaker, so no
 * attempt can make a request-specific answer open the breaker every client shares.
 */
// oxlint-disable-next-line unicorn/custom-error-definition -- a marker type, not a generic Error
class ProviderOutage extends Error {
  readonly reason: string;
  readonly refused: boolean;

  constructor(reason: string, refused: boolean) {
    super(reason);
    this.name = "ProviderOutage";
    this.reason = reason;
    this.refused = refused;
  }
}

/** One upstream exchange; `send` adds the provider's auth headers and the attempt's signal. */
export type UpstreamRequest = {
  readonly url: string | URL;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * What this call costs the provider account, in the account's own metering unit (compute units or
   * request credits) — required, so no call can reach the upstream unbilled.
   */
  readonly cost: number;
  /**
   * A deadline for a body streamed past the attempt (Esplora), which the attempt timeout no longer
   * bounds once the attempt has returned.
   */
  readonly bodyDeadlineMs?: number;
};

/** A provider's answer to one request, for the attempt to interpret. */
export type UpstreamResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  /**
   * The body as text: over `maxBytes` throws {@link ResponseTooLarge} (the request's own answer), a
   * read that breaks mid-body is a transport outage.
   */
  readonly text: (maxBytes: number) => Promise<string>;
  /** The raw body for pass-through; the caller bounds it. */
  // oxlint-disable-next-line typescript/no-restricted-types -- fetch's own shape: null when bodiless
  readonly body: ReadableStream<Uint8Array> | null;
};

/**
 * Sends one request to the attempt's provider. Every status below 500 except 429 comes back for the
 * attempt to interpret; transport errors, 5xx and 429 throw the outage the breaker counts.
 */
export type Send = (request: UpstreamRequest) => Promise<UpstreamResponse>;

export type Forwarded<T> = { readonly value: T; readonly providerId: string };

/**
 * Bills `units` of `account`'s own metering unit to the client's share of that account, before the
 * call it pays for is sent. Throws a `GatewayHttpError` (429/413) when the request's share is spent
 * — that error ends the walk unmetered-by-the-breaker, never a provider outage.
 */
export type Meter = (account: string, units: number) => Promise<void>;

export type ForwardOptions = {
  /** Required: every upstream call passes its share charge first. */
  readonly meter: Meter;
  /**
   * The call relays a signed transaction. Retrying it on another provider can broadcast the same
   * transaction twice, so failover is allowed only when the failed attempt provably never reached
   * the provider: its breaker was open, or it refused the call (`refused`). Any other failure stops
   * the walk with a 502 outcome-unknown.
   */
  readonly broadcast?: boolean;
};

export type Forwarder = {
  /**
   * Runs `attempt` against each provider in order, skipping any whose breaker is open; `attempt`
   * reaches its provider only through `send`. A returned value ends the walk; a failed attempt
   * cancels its other in-flight calls. An outage, a timeout or a {@link ProviderFailure} moves on to
   * the next provider; a `GatewayHttpError` or a {@link ResponseTooLarge} is the request's own
   * answer (a 400 for the latter) and ends the walk. When every provider fails the caller gets a 503.
   * Only outages and timeouts count against the shared breaker.
   */
  run: <T>(
    providers: ReadonlyArray<ResolvedProvider>,
    attempt: (send: Send, provider: ResolvedProvider) => Promise<T>,
    options: ForwardOptions,
  ) => Promise<Forwarded<T>>;
};

const counted = (error: unknown): boolean =>
  error instanceof ProviderOutage || error instanceof TaskCancelledError;

/** Whether the provider provably never processed the attempt, so a broadcast may fail over. */
const refused = (error: unknown): boolean =>
  error instanceof BrokenCircuitError ||
  ((error instanceof ProviderOutage || error instanceof ProviderFailure) && error.refused);

/** The failure class of one attempt — logged, never returned to the caller. */
const failureReason = (error: unknown): string => {
  if (error instanceof ProviderOutage || error instanceof ProviderFailure) {
    return error.reason;
  }
  if (error instanceof TaskCancelledError) {
    return "timeout";
  }
  if (error instanceof BrokenCircuitError) {
    return "breaker-open";
  }
  if (error instanceof ResponseTooLarge) {
    return "too-large";
  }
  return error instanceof GatewayHttpError ? "rejected" : "error";
};

const sendTo =
  (
    fetch: typeof globalThis.fetch,
    provider: ResolvedProvider,
    meter: Meter,
    budget: ProviderBudget,
    signal: AbortSignal,
  ): Send =>
  async (request) => {
    // The client pays its share of the provider account before the call exists: a refused
    // charge is the request's own 429/413 and nothing is sent.
    await meter(provider.account, request.cost);
    if (request.cost > 0) {
      // Then the account's shared quota: a refusal fails over — never a breaker outage, and the
      // account's known wait time reaches the client when every provider is out of budget.
      const decision = await budget.take(provider.account, request.cost);
      if (!decision.ok) {
        throw new ProviderFailure("budget", true, decision.retryAfterSeconds);
      }
    }
    let auth: Readonly<Record<string, string>>;
    try {
      auth = (await provider.auth?.()) ?? {};
    } catch {
      // Nothing was sent: the provider's account is unusable, not the request.
      throw new ProviderOutage("auth", true);
    }
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers: { ...request.headers, ...auth },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal:
          request.bodyDeadlineMs === undefined
            ? signal
            : AbortSignal.any([signal, AbortSignal.timeout(request.bodyDeadlineMs)]),
      });
    } catch {
      throw new ProviderOutage("transport", false);
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      // A 429 is the gateway's own account being throttled: refused before processing.
      throw new ProviderOutage(`status-${response.status}`, response.status === 429);
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: async (maxBytes) => {
        try {
          return await readCapped(response, maxBytes);
        } catch (error) {
          if (error instanceof ResponseTooLarge) {
            throw error;
          }
          throw new ProviderOutage("transport", false);
        }
      },
      body: response.body,
    };
  };

/**
 * The one path from a route to an upstream. Policies are kept per provider id for the life of the
 * isolate, so breaker state accumulates. `log` receives one JSON line per failed attempt, per
 * breaker transition, and once when every provider of a run fails — observability for attacks,
 * quota exhaustion and upstream outages.
 */
export function createForwarder(
  fetch: typeof globalThis.fetch,
  log: (line: string) => void,
  deps: { readonly budget: ProviderBudget },
): Forwarder {
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
      attempt: (send: Send, provider: ResolvedProvider) => Promise<T>,
      options: ForwardOptions,
    ): Promise<Forwarded<T>> {
      // The shortest announced wait among budget refusals (and later cool-downs): when every
      // provider failed it replaces the fixed 30 s `Retry-After` on the 503.
      let retryAfter = UNAVAILABLE_RETRY_AFTER_SECONDS;
      const from = async (index: number): Promise<Forwarded<T>> => {
        const provider = providers[index];
        if (provider === undefined) {
          log(
            JSON.stringify({
              event: "all-providers-failed",
              providers: providers.map((p) => p.id),
            }),
          );
          throw new GatewayHttpError(503, "unavailable", Math.max(1, retryAfter));
        }
        try {
          const value = await policyFor(provider).execute(async ({ signal }) => {
            // A failed attempt drops its other in-flight calls (one `send` each), which would
            // otherwise keep spending the provider's quota; a successful attempt leaves them —
            // a streamed Esplora body outlives it.
            const failed = new AbortController();
            try {
              return await attempt(
                sendTo(
                  fetch,
                  provider,
                  options.meter,
                  deps.budget,
                  AbortSignal.any([signal, failed.signal]),
                ),
                provider,
              );
            } catch (error) {
              failed.abort();
              throw error;
            }
          });
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
          if (error instanceof ResponseTooLarge) {
            // The caller chose an answer too large to relay; the next provider would send the same.
            throw new GatewayHttpError(400, "invalid-request");
          }
          if (
            !(
              counted(error) ||
              error instanceof ProviderFailure ||
              error instanceof BrokenCircuitError
            )
          ) {
            throw error;
          }
          if (options.broadcast === true && !refused(error)) {
            // The provider may have relayed the transaction; no other answer is safe to invent.
            throw new GatewayHttpError(502, "outcome-unknown");
          }
          if (error instanceof ProviderFailure && error.retryAfterSeconds !== undefined) {
            retryAfter = Math.min(retryAfter, error.retryAfterSeconds);
          }
          return from(index + 1);
        }
      };
      return from(0);
    },
  };
}

function makePolicy(log: (line: string) => void, provider: ResolvedProvider) {
  const breaker = circuitBreaker(handleWhen(counted), {
    halfOpenAfter: BREAKER_HALF_OPEN_MS,
    breaker: new ConsecutiveBreaker(BREAKER_FAILURES),
  });
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
