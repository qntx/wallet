/**
 * The rate-limiting binding shape (`PUSH_LIMITER` and friends) and the bundle every request's
 * limiters form. A leaf module: `types.ts` composes the bundle, `push/backend.ts` takes the one
 * push limiter — importing it from `types.ts` would close a cycle back through `PushService`.
 */
export type RateLimiter = {
  limit: (options: { key: string; delta?: number }) => Promise<{ success: boolean }>;
};

export type Limiters = {
  /** Per IP prefix across every client id — the ceiling rotating client ids cannot escape. */
  readonly ip: RateLimiter;
  readonly rpc: RateLimiter;
  readonly default: RateLimiter;
  /**
   * Shares of each provider account's per-minute budget, keyed `account:ip-prefix`: one client's
   * traffic is bounded in the provider's own units even when its calls are cheap per request.
   */
  readonly share: RateLimiter;
};
