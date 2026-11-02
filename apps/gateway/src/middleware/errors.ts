import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import type { GatewayErrorCode } from "@qntx/wallet-engine/gateway/contract";

type ErrorStatus = 400 | 404 | 429 | 500 | 503;

/** An error with a fixed HTTP mapping; the body carries only the contract error code. */
export class GatewayHttpError extends Error {
  readonly status: ErrorStatus;
  readonly code: GatewayErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: ErrorStatus, code: GatewayErrorCode, retryAfterSeconds?: number) {
    super(code);
    this.name = "GatewayHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const respond = (c: Context, error: GatewayHttpError): Response => {
  if (error.retryAfterSeconds !== undefined) {
    c.header("retry-after", String(error.retryAfterSeconds));
  }
  return c.json({ error: error.code }, error.status);
};

/** Maps every thrown value to a contract error body; internal failures carry no detail. */
export function mapError(error: unknown, c: Context): Response {
  if (error instanceof GatewayHttpError) {
    return respond(c, error);
  }
  if (error instanceof HTTPException && error.status === 400) {
    return respond(c, new GatewayHttpError(400, "invalid-request"));
  }
  return respond(c, new GatewayHttpError(500, "internal"));
}

export function notFound(c: Context): Response {
  return respond(c, new GatewayHttpError(404, "not-found"));
}
