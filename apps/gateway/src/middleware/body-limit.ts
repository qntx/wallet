import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import { GatewayHttpError } from "./errors.ts";

/**
 * Rejects a request body larger than `maxSize` bytes before it is read (Content-Length first, then
 * the streamed byte count), so oversized payloads never reach an upstream.
 */
export const limitBody = (maxSize: number): MiddlewareHandler =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw new GatewayHttpError(413, "invalid-request");
    },
  });
