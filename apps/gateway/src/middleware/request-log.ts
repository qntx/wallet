import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

import { PROVIDERS_HEADER } from "@qntx/wallet-engine/gateway/contract";

/**
 * One JSON line per request: route template, status, duration and serving provider. Parameters,
 * bodies and client addresses are never logged.
 */
export const requestLog =
  (write: (line: string) => void): MiddlewareHandler =>
  async (c, next) => {
    const started = Date.now();
    await next();
    write(
      JSON.stringify({
        route: routePath(c, -1),
        status: c.res.status,
        ms: Date.now() - started,
        provider: c.res.headers.get(PROVIDERS_HEADER),
      }),
    );
  };
