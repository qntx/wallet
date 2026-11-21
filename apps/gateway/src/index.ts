import { createGateway } from "./app.ts";
import { PHISHING_SOURCES } from "./config/phishing.ts";
import { buildPhishingList } from "./risk/phishing.ts";
import { buildTokenLists } from "./tokens/build.ts";
import { gatewayFor, riskStoreOf, tokenSourcesFor } from "./worker.ts";
import type { WorkerEnv } from "./worker.ts";

// The PROVIDER_BUDGET binding resolves this class by name.
export { ProviderBudgetObject } from "./budget/durable.ts";

type Gateway = ReturnType<typeof createGateway>;

// Bindings are stable for the life of an isolate, so the app (and its breaker state) is built once.
let gateway: Gateway | undefined;

const log = (line: string): void => {
  console.log(line);
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    gateway ??= createGateway(gatewayFor(env));
    return gateway.fetch(request);
  },
  scheduled(_controller, env, ctx): void {
    const store = riskStoreOf(env.RISK);
    ctx.waitUntil(
      Promise.all([
        buildPhishingList({
          fetch: async (input, init) => fetch(input, init),
          store,
          now: () => Date.now(),
          log,
          sources: PHISHING_SOURCES,
        }),
        buildTokenLists({
          fetch: async (input, init) => fetch(input, init),
          store,
          now: () => Date.now(),
          log,
          sources: tokenSourcesFor(env),
        }),
      ]),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
