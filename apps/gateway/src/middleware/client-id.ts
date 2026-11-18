import type { MiddlewareHandler } from "hono";

import { CLIENT_ID_HEADER, accepts, clientId, health } from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "./errors.ts";

export type ClientIdVariables = { clientId: string };

/** Requires a well-formed `x-client-id` on every route except health. */
export const requireClientId: MiddlewareHandler<{ Variables: ClientIdVariables }> = async (
  c,
  next,
) => {
  if (c.req.path === health.path) {
    await next();
    return;
  }
  const id = c.req.header(CLIENT_ID_HEADER);
  if (id === undefined || !accepts(clientId, id)) {
    throw new GatewayHttpError(400, "invalid-request");
  }
  c.set("clientId", id);
  await next();
};
