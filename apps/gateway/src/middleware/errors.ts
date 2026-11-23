import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import type { GatewayErrorCode } from "@qntx/wallet-engine/gateway/contract";

export type ErrorStatus = 400 | 404 | 413 | 429 | 500 | 502 | 503;

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

/**
 * Maps every thrown value to a contract error body; internal failures carry no detail on the wire
 * but log the error class name so an outage can be told apart from a client error.
 */
export function mapError(log: (line: string) => void) {
  return (error: unknown, c: Context): Response => {
    if (error instanceof GatewayHttpError) {
      return respond(c, error);
    }
    if (error instanceof HTTPException && error.status === 400) {
      return respond(c, new GatewayHttpError(400, "invalid-request"));
    }
    log(
      JSON.stringify({
        event: "internal-error",
        name: error instanceof Error ? error.name : typeof error,
      }),
    );
    return respond(c, new GatewayHttpError(500, "internal"));
  };
}

export function notFound(c: Context): Response {
  return respond(c, new GatewayHttpError(404, "not-found"));
}
