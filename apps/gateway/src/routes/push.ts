/**
 * The push routes: `GET /v1/push` advertises capabilities, `PUT/DELETE …/subscription` and `POST
 * …/transactions` reach the family's `PushObject` through the injected backend. Auth is the
 * subscription secret — `Authorization: Bearer base64url(32 bytes)` — whose one-way SHA-256
 * derivative is the subscription id, so the id never travels the wire. Push writes are charged on
 * the `PUSH_LIMITER` binding keyed by the client's IP prefixes, on top of the shared limiters.
 */
import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import {
  PUSH_AUTH_SCHEME,
  accepts,
  pushCapabilities,
  pushSecret,
  pushSubscribe,
  pushSubscriptionRequest,
  pushTransactionRequest,
  pushUnsubscribe,
  pushWatch,
} from "@qntx/wallet-engine/gateway/contract";
import type { PushFamily } from "@qntx/wallet-engine/gateway/contract";

import { limitBody } from "../middleware/body-limit.ts";
import type { ClientIdVariables } from "../middleware/client-id.ts";
import { GatewayHttpError } from "../middleware/errors.ts";
import { RATE_LIMIT_RETRY_AFTER_SECONDS, clientKeys } from "../middleware/rate-limit.ts";
import type { RateLimitVariables } from "../middleware/rate-limit.ts";
import { pushFamilyOf } from "../push/backend.ts";
import type { PushBackend, PushService } from "../push/backend.ts";
import { base64urlBytes } from "../push/encoding.ts";
import { subscriptionIdOf } from "../push/seal.ts";

/*
 * Body caps from the schema maxima: a subscription carries a 4096-char token, a 43-char key,
 * 64 CAIP-2 networks (~42 chars each) and 64 addresses (~130 chars each) plus JSON syntax —
 * ~15.6 KiB, bounded at 16 KiB. A transaction watch is `{network, hash}` — a few hundred bytes.
 */
const SUBSCRIPTION_MAX_BODY = 16 * 1024;
const WATCH_MAX_BODY = 1024;

/** PUT rewrites a subscription's whole row set; DELETE/POST are lookups. */
const SUBSCRIBE_UNITS = 5;
const WRITE_UNITS = 1;

type PushVariables = ClientIdVariables &
  RateLimitVariables & { pushFamily: PushFamily; pushBackend: PushBackend; pushId: string };

const badRequest = (): never => {
  throw new GatewayHttpError(400, "invalid-request");
};

/** The `Bearer <pushSecret>` credential, or a 400 — the id is derived, never transported. */
const bearerSecret = (header: string | undefined): Uint8Array => {
  const token =
    header !== undefined && header.startsWith(`${PUSH_AUTH_SCHEME} `)
      ? header.slice(PUSH_AUTH_SCHEME.length + 1)
      : undefined;
  const secret =
    token !== undefined && accepts(pushSecret, token) ? base64urlBytes(token) : undefined;
  if (secret === undefined || secret.length !== 32) {
    throw new GatewayHttpError(400, "invalid-request");
  }
  return secret;
};

/** Charges `units` on the push limiter for every IP prefix key the client carries. */
const chargePush = async (
  ip: string | undefined,
  limiter: PushService["limiter"],
  units: number,
): Promise<void> => {
  const keys = clientKeys(ip) ?? ["unknown"];
  const outcomes = await Promise.all(keys.map(async (key) => limiter.limit({ key, delta: units })));
  if (outcomes.some((outcome) => !outcome.success)) {
    throw new GatewayHttpError(429, "rate-limited", RATE_LIMIT_RETRY_AFTER_SECONDS);
  }
};

export function pushRoutes(push: PushService | undefined): Hono<{ Variables: PushVariables }> {
  const routes = new Hono<{ Variables: PushVariables }>();

  routes.get(pushCapabilities.path, (c) =>
    push === undefined
      ? c.json({ platforms: [], families: [] })
      : c.json({ platforms: [...push.platforms], families: [...push.families] }),
  );

  /**
   * Family → 404 unsupported, bearer → 400, push limiter → 429; stashes the family, backend and
   * derived subscription id for the handler. Runs before `sValidator` so malformed bodies are
   * charged too.
   */
  const access =
    (units: number): MiddlewareHandler<{ Variables: PushVariables }> =>
    async (c, next) => {
      const family = pushFamilyOf(c.req.param("family") ?? "");
      if (push === undefined || family === undefined || !push.families.includes(family)) {
        throw new GatewayHttpError(404, "unsupported");
      }
      const secret = bearerSecret(c.req.header("authorization"));
      await chargePush(c.req.header("cf-connecting-ip"), push.limiter, units);
      c.set("pushFamily", family);
      c.set("pushBackend", push.backend(family));
      c.set("pushId", await subscriptionIdOf(secret));
      await next();
    };

  routes.put(
    pushSubscribe.path,
    limitBody(SUBSCRIPTION_MAX_BODY),
    access(SUBSCRIBE_UNITS),
    sValidator("json", pushSubscriptionRequest, (result) => {
      if (!result.success) {
        badRequest();
      }
    }),
    async (c) => {
      const result = await c.get("pushBackend").subscribe({
        id: c.get("pushId"),
        ...c.req.valid("json"),
      });
      if (!result.ok) {
        throw new GatewayHttpError(result.status, result.code);
      }
      return c.json(result.value, 200);
    },
  );

  routes.delete(pushUnsubscribe.path, access(WRITE_UNITS), async (c) => {
    const result = await c.get("pushBackend").unsubscribe(c.get("pushId"));
    if (!result.ok) {
      throw new GatewayHttpError(result.status, result.code);
    }
    return c.body(null, 204);
  });

  routes.post(
    pushWatch.path,
    limitBody(WATCH_MAX_BODY),
    access(WRITE_UNITS),
    sValidator("json", pushTransactionRequest, (result) => {
      if (!result.success) {
        badRequest();
      }
    }),
    async (c) => {
      const result = await c.get("pushBackend").watch({
        id: c.get("pushId"),
        ...c.req.valid("json"),
      });
      if (!result.ok) {
        throw new GatewayHttpError(result.status, result.code);
      }
      return c.json({}, 200);
    },
  );

  return routes;
}
