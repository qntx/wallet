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
export const PROBE_TIMEOUT_MS = 3000;
/** A probe verdict is reused for this long, so a burst of timeouts on one provider costs one probe. */
export const PROBE_VERDICT_MS = 10_000;
/** A 429 parks its account at most this long; an absent or unparseable `Retry-After` means 5 s. */
export const COOLDOWN_MAX_SECONDS = 30;
export const COOLDOWN_DEFAULT_SECONDS = 5;

/** Statuses a JSON-RPC upstream answers when the request itself is wrong: the caller's own 400. */
export const REQUEST_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/** Statuses where the provider refused the call before processing it (a broadcast may fail over). */
export const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * A failed attempt that is never a provider outage: a refusal (401/403, `refused`), a 429 (the
 * account parks itself and the walk fails over), a spent budget, a parked account, a timeout the
 * provider disproved by answering its probe, a malformed body, an upstream JSON-RPC error, or a
 * status the attempt does not serve. The breaker never counts these — every one is an answer a
 * client can provoke with its own input, or a wait the provider announced itself.
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
 * A provider-wide failure observed by {@link Send}: transport, 5xx, a failed auth lookup — or a
 * timed-out attempt whose probe also failed, which is what a dead provider looks like. Only `send`
 * and the probe verdict construct it and only it counts against the breaker, so no attempt can make
 * a request-specific answer (or its own slowness) open the breaker every client shares.
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
 * attempt to interpret; transport errors and 5xx throw the outage the breaker counts, while a 429
 * throws a refusal that parks the account and a parked account or a spent budget throws without a
 * byte being sent.
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
   * Runs `attempt` against each provider in order, skipping any whose breaker is open or whose
   * account is cooling down; `attempt` reaches its provider only through `send`. A returned value
   * ends the walk; a failed attempt cancels its other in-flight calls. An outage or a
   * {@link ProviderFailure} moves on to the next provider; a `GatewayHttpError` or a
   * {@link ResponseTooLarge} is the request's own answer (a 400 for the latter) and ends the walk.
   * When every provider fails the caller gets a 503 with the shortest announced wait. Only outages
   * count against the shared breaker — and a timeout only becomes one when the provider's probe
   * also fails.
   */
  run: <T>(
    providers: ReadonlyArray<ResolvedProvider>,
    attempt: (send: Send, provider: ResolvedProvider) => Promise<T>,
    options: ForwardOptions,
  ) => Promise<Forwarded<T>>;
};

const counted = (error: unknown): boolean => error instanceof ProviderOutage;

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

/** Delta-seconds only; an HTTP-date or anything unparseable counts as absent. */
// oxlint-disable-next-line typescript/no-restricted-types -- Headers.get returns null
const parseRetryAfter = (header: string | null): number | undefined =>
  header !== null && /^\d+$/.test(header) ? Math.trunc(Number(header)) : undefined;

/** Probes never touch the client share: they answer for the provider, not for the request. */
const probeMeter: Meter = async () => {
  await Promise.resolve();
};

/** Per-isolate account cool-down state the forwarder consults before metering. */
type Throttle = {
  /** Whole seconds left on the account's cool-down; 0 when callable (expired entries dropped). */
  readonly remaining: (account: string) => number;
  /** Parks the account for `seconds`, logging once when a fresh cool-down starts. */
  readonly park: (account: string, seconds: number) => void;
};

const sendTo =
  (
    fetch: typeof globalThis.fetch,
    provider: ResolvedProvider,
    meter: Meter,
    budget: ProviderBudget,
    signal: AbortSignal,
    throttle: Throttle,
  ): Send =>
  async (request) => {
    const cooled = throttle.remaining(provider.account);
    if (cooled > 0) {
      // The account itself announced the wait: the client is never charged for a skipped call.
      throw new ProviderFailure("cooling-down", true, cooled);
    }
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
    if (response.status === 429) {
      const seconds = Math.min(
        parseRetryAfter(response.headers.get("retry-after")) ?? COOLDOWN_DEFAULT_SECONDS,
        COOLDOWN_MAX_SECONDS,
      );
      await response.body?.cancel().catch(() => undefined);
      // The account itself is throttled (Alchemy bills per account, across networks): park every
      // provider of it and fail over — a refusal before processing, never an outage.
      throttle.park(provider.account, seconds);
      throw new ProviderFailure("status-429", true, seconds);
    }
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderOutage(`status-${response.status}`, false);
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
  deps: { readonly budget: ProviderBudget; readonly now?: () => number },
): Forwarder {
  const now = deps.now ?? Date.now;
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

  /** Accounts a 429 parked, until ms epoch — per isolate; other isolates cool on their own 429s. */
  const cooldowns = new Map<string, number>();
  const throttle: Throttle = {
    remaining: (account) => {
      const until = cooldowns.get(account);
      if (until === undefined) {
        return 0;
      }
      const remaining = Math.ceil((until - now()) / 1000);
      if (remaining <= 0) {
        cooldowns.delete(account);
        return 0;
      }
      return remaining;
    },
    park: (account, seconds) => {
      const already = throttle.remaining(account) > 0;
      cooldowns.set(account, now() + seconds * 1000);
      if (!already) {
        log(JSON.stringify({ event: "upstream-throttled", account, retryAfter: seconds }));
      }
    },
  };

  /** Latest probe verdict per provider (keyed like the policies); in-flight probes single-flight. */
  const probeVerdicts = new Map<string, { readonly at: number; readonly failed: boolean }>();
  const probeFlights = new Map<string, Promise<boolean>>();

  /**
   * Whether the provider's probe proves it dead after an attempt timed out. A provider without a
   * probe reports healthy — its timeout is its own slowness and never counts.
   */
  const probeFailed = async (provider: ResolvedProvider): Promise<boolean> => {
    const { probe } = provider;
    if (probe === undefined) {
      return false;
    }
    const key = `${provider.id}|${provider.url}`;
    const cached = probeVerdicts.get(key);
    if (cached !== undefined && now() - cached.at < PROBE_VERDICT_MS) {
      return cached.failed;
    }
    const flying = probeFlights.get(key);
    if (flying !== undefined) {
      return flying;
    }
    const flight = (async (): Promise<boolean> => {
      try {
        // The probe runs through the provider's own policy, so its transport error, 5xx or own
        // timeout is the ONE outage the attempt's timeout stands for; a ProviderFailure (cooling
        // account, spent budget, a probe-side 429) counts nothing.
        const response = await policyFor(provider).execute(async ({ signal }) =>
          sendTo(
            fetch,
            provider,
            probeMeter,
            deps.budget,
            AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
            throttle,
          )(probe),
        );
        // Any answer under 500 is a live provider.
        await response.body?.cancel().catch(() => undefined);
        return false;
      } catch (error) {
        return error instanceof ProviderOutage;
      }
    })();
    probeFlights.set(key, flight);
    try {
      const failed = await flight;
      probeVerdicts.set(key, { at: now(), failed });
      return failed;
    } finally {
      probeFlights.delete(key);
    }
  };

  /**
   * What a timed-out attempt means for the breaker: the probe failing is one outage (a dead
   * provider), the probe answering — or the provider having no probe — is the provider's own
   * slowness, a failure that fails over but counts nothing.
   */
  const classifyTimeout = async (
    provider: ResolvedProvider,
  ): Promise<ProviderFailure | ProviderOutage> =>
    (await probeFailed(provider))
      ? new ProviderOutage("probe", false)
      : new ProviderFailure("timeout", false);

  return {
    async run<T>(
      providers: ReadonlyArray<ResolvedProvider>,
      attempt: (send: Send, provider: ResolvedProvider) => Promise<T>,
      options: ForwardOptions,
    ): Promise<Forwarded<T>> {
      // The shortest announced wait among budget refusals and cool-downs: when every provider
      // failed it replaces the fixed 30 s `Retry-After` on the 503.
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
                  throttle,
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
          // A timeout alone says nothing about the provider — ask its probe (once, briefly
          // cached) whether it is still alive before deciding whether the attempt counted.
          const failure =
            error instanceof TaskCancelledError ? await classifyTimeout(provider) : error;
          log(
            JSON.stringify({
              event: "upstream-failure",
              provider: provider.id,
              upstream: provider.url,
              reason: failureReason(failure),
            }),
          );
          if (failure instanceof ResponseTooLarge) {
            // The caller chose an answer too large to relay; the next provider would send the same.
            throw new GatewayHttpError(400, "invalid-request");
          }
          if (
            !(
              counted(failure) ||
              failure instanceof ProviderFailure ||
              failure instanceof BrokenCircuitError
            )
          ) {
            throw failure;
          }
          if (options.broadcast === true && !refused(failure)) {
            // The provider may have relayed the transaction; no other answer is safe to invent.
            throw new GatewayHttpError(502, "outcome-unknown");
          }
          if (failure instanceof ProviderFailure && failure.retryAfterSeconds !== undefined) {
            retryAfter = Math.min(retryAfter, failure.retryAfterSeconds);
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
