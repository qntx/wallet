import { createGateway } from "./app.ts";
import { PHISHING_SOURCES } from "./config/phishing.ts";
import type { WorkerEnv } from "./env.ts";
import { buildPhishingList } from "./risk/phishing.ts";
import { buildTokenLists } from "./tokens/build.ts";
import type { Upstream } from "./upstream.ts";
import { upstreamFor } from "./upstream.ts";
import { gatewayFor, pushServiceFor, riskStoreOf, tokenSourcesFor } from "./worker.ts";

// The PROVIDER_BUDGET and PUSH bindings resolve these classes by name.
export { ProviderBudgetObject } from "./budget/durable.ts";
export { PushObject } from "./push/object.ts";

type Gateway = ReturnType<typeof createGateway>;

// Bindings are stable for the life of an isolate, so the app (and its breaker state) is built once.
// Push secrets are async to import, so the once-only build is a promise.
let building: Promise<Gateway> | undefined;

const build = async (env: WorkerEnv): Promise<Gateway> => {
  building ??= (async () => {
    const options = gatewayFor(env);
    const push = await pushServiceFor(env);
    return createGateway(push === undefined ? options : { ...options, push });
  })();
  return building;
};

const log = (line: string): void => {
  console.log(line);
};

// The cron isolate's own view of the shared account budgets — same construction the fetch handler
// uses, so the hourly token-list build pays into the same accounts the routes draw from.
let upstream: Upstream | undefined;
const cronUpstream = (env: WorkerEnv): Upstream => {
  upstream ??= upstreamFor(env, fetch, log);
  return upstream;
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const gateway = await build(env);
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
          budget: cronUpstream(env).budget,
        }),
      ]),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
