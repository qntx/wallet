import type { MiddlewareHandler } from "hono";

import { health } from "@qntx/wallet-engine/gateway/contract";

import type { Limiters, RateLimiter } from "../types.ts";
import { GatewayHttpError } from "./errors.ts";
import type { InstallIdVariables } from "./install-id.ts";

/** Matches the `period` of the Workers rate-limit bindings in wrangler.jsonc. */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 10;

/** IPv4 → /24, IPv6 → /48; the full address never reaches a counter key or a log. */
export function ipPrefix(ip: string | undefined): string {
  if (ip === undefined || ip === "") {
    return "unknown";
  }
  if (!ip.includes(":")) {
    const octets = ip.split(".");
    return octets.length === 4 ? `${octets.slice(0, 3).join(".")}.0/24` : "unknown";
  }
  const [head = "", tail] = ip.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array.from({ length: 8 - front.length - back.length }, () => "0"), ...back];
  return `${groups
    .slice(0, 3)
    .map((g) => g.toLowerCase().padStart(4, "0"))
    .join(":")}::/48`;
}

const TRANSPORT_PREFIXES = ["/v1/rpc/", "/v1/esplora/"];

/**
 * Two counters per request, health exempt: the IP-prefix limiter first (install ids are chosen by
 * the client, so this is the only bound a script rotating them meets), then "install id + IP
 * prefix" in the group's binding (transport routes use the RPC limiter, everything else the
 * default). Either refusing answers 429 with `Retry-After`.
 */
export const rateLimit =
  (limiters: Limiters): MiddlewareHandler<{ Variables: InstallIdVariables }> =>
  async (c, next) => {
    if (c.req.path === health.path) {
      await next();
      return;
    }
    const prefix = ipPrefix(c.req.header("cf-connecting-ip"));
    const limiter: RateLimiter = TRANSPORT_PREFIXES.some((p) => c.req.path.startsWith(p))
      ? limiters.rpc
      : limiters.default;
    const byIp = await limiters.ip.limit({ key: prefix });
    const byInstall = byIp.success
      ? await limiter.limit({ key: `${c.get("installId")}:${prefix}` })
      : byIp;
    if (!byInstall.success) {
      throw new GatewayHttpError(429, "rate-limited", RATE_LIMIT_RETRY_AFTER_SECONDS);
    }
    await next();
  };
