import { createGateway } from "./app.ts";
import { PHISHING_SOURCES } from "./config/phishing.ts";
import { buildPhishingList } from "./risk/phishing.ts";
import { gatewayFor, riskStoreOf } from "./worker.ts";
import type { WorkerEnv } from "./worker.ts";

type Gateway = ReturnType<typeof createGateway>;

// Bindings are stable for the life of an isolate, so the app (and its breaker state) is built once.
let gateway: Gateway | undefined;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    gateway ??= createGateway(gatewayFor(env));
    return gateway.fetch(request);
  },
  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(
      buildPhishingList({
        fetch: async (input, init) => fetch(input, init),
        store: riskStoreOf(env.RISK),
        now: () => Date.now(),
        log: (line) => {
          console.log(line);
        },
        sources: PHISHING_SOURCES,
      }),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
