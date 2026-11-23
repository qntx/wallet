/**
 * Provider webhooks — outside `/v1`, so no client id and no client rate limit (the request log and
 * error mapping still apply). `POST /hooks/alchemy` authenticates on the payload's `webhookId`: the
 * configured signing key verifies `X-Alchemy-Signature` over the raw body, the payload is folded
 * into observations and `ingest`ed into the `evm` object. Alchemy retries every non-2xx answer, so
 * a backend failure is a 503 — a retry replays the same activities, which `tid` dedup already
 * absorbs. A bad signature, an unknown webhook or a malformed payload is a 400: retrying can never
 * fix it.
 */
import { Hono } from "hono";
import * as z from "zod/mini";

import { limitBody } from "../middleware/body-limit.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import type { PushService } from "../push/backend.ts";
import {
  alchemyObservations,
  alchemyPayloadSchema,
  verifyAlchemySignature,
} from "../push/watch-alchemy.ts";

/**
 * The documented payload is a handful of kilobytes per activity; thousands of activities still fit
 * comfortably, and the cap keeps a signed-but-hostile delivery bounded.
 */
const HOOK_MAX_BODY = 2 * 1024 * 1024;

const headSchema = z.looseObject({ webhookId: z.string() });

export function hooksRoutes(push: PushService | undefined, log: (line: string) => void): Hono {
  const routes = new Hono();

  routes.post("/hooks/alchemy", limitBody(HOOK_MAX_BODY), async (c) => {
    const alchemy = push?.alchemy;
    if (push === undefined || alchemy === undefined) {
      throw new GatewayHttpError(404, "unsupported");
    }
    const raw = await c.req.raw.text();
    let head: unknown;
    try {
      head = JSON.parse(raw);
    } catch {
      throw new GatewayHttpError(400, "invalid-request");
    }
    const id = z.safeParse(headSchema, head);
    if (!id.success) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    const hook = alchemy.get(id.data.webhookId);
    if (hook === undefined) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    // The header authenticates the whole raw body — parse order matters, verify before trusting.
    const verified = await verifyAlchemySignature(
      raw,
      c.req.header("x-alchemy-signature"),
      hook.signingKey,
    );
    if (!verified) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    const parsed = z.safeParse(alchemyPayloadSchema, head);
    if (!parsed.success || parsed.data.type !== "ADDRESS_ACTIVITY") {
      throw new GatewayHttpError(400, "invalid-request");
    }
    const { items, dropped } = alchemyObservations(parsed.data, hook.network);
    if (dropped > 0) {
      // A truncated delivery loses activity permanently — count-only, like every push log.
      log(JSON.stringify({ event: "push-hook", dropped }));
    }
    const result = await push.backend("evm").ingest(items);
    if (!result.ok) {
      // Alchemy retries a non-2xx delivery; ingest is idempotent through tid dedup.
      throw new GatewayHttpError(503, "unavailable");
    }
    return c.json({}, 200);
  });

  return routes;
}
