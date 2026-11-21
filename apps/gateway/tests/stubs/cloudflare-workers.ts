/**
 * Test stand-in for the `cloudflare:workers` runtime module (aliased in vite.config.ts): only the
 * `DurableObject` base `src/budget/durable.ts` extends. The ambient `DurableObjectState` type is
 * the real one from `worker-configuration.d.ts`; tests pass a fake state into the constructor.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
