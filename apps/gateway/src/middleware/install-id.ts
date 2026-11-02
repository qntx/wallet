import type { MiddlewareHandler } from "hono";

import {
  INSTALL_ID_HEADER,
  accepts,
  health,
  installId,
} from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "./errors.ts";

export type InstallIdVariables = { installId: string };

/** Requires a well-formed `x-install-id` on every route except health. */
export const requireInstallId: MiddlewareHandler<{ Variables: InstallIdVariables }> = async (
  c,
  next,
) => {
  if (c.req.path === health.path) {
    await next();
    return;
  }
  const id = c.req.header(INSTALL_ID_HEADER);
  if (id === undefined || !accepts(installId, id)) {
    throw new GatewayHttpError(400, "invalid-request");
  }
  c.set("installId", id);
  await next();
};
