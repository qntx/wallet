import type { MiddlewareHandler } from "hono";

import { health } from "@qntx/wallet-engine/gateway/contract";

import type { Account } from "../config/accounts.ts";
import type { Meter } from "../providers/forward.ts";
import type { Limiters, RateLimiter } from "../types.ts";
import type { ClientIdVariables } from "./client-id.ts";
import { GatewayHttpError } from "./errors.ts";

/** Matches the `period` of the Workers rate-limit bindings in wrangler.jsonc. */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 10;

/** The `SHARE_LIMITER` binding's limit: one IP's share units per account per minute. */
export const SHARE_LIMIT = 1000;
/** Matches the binding's 60-second period. */
export const SHARE_RETRY_AFTER_SECONDS = 60;

/** The slowest of an account's windows, expressed as units per minute. */
const perMinute = (account: Account): number =>
  Math.min(...account.budget.map((window) => (window.units * 60) / window.seconds));

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

export type RateLimitVariables = {
  /**
   * Charges `units` more on this request's two limiter keys (IP prefix, then client id + prefix);
   * throws `429 rate-limited` when either refuses. `units <= 0` is a no-op.
   */
  charge: (units: number) => Promise<void>;
  /**
   * Bills `units` of a provider account's own cost unit to this request's share of that account
   * (`account:ip-prefix` on the share limiter). Throws `429 rate-limited` when the share is spent
   * and `413 too-costly` when one delta exceeds the whole client window — before any limiter call.
   */
  meter: Meter;
};

/**
 * Two counters per request, health exempt: the IP-prefix limiter first (client ids are chosen by
 * the client, so this is the only bound a script rotating them meets), then "client id + IP prefix"
 * in the group's binding (transport routes use the RPC limiter, everything else the default).
 * Either refusing answers 429 with `Retry-After`. Routes charge extra units through the `charge`
 * variable: a batch costs the sum of its calls, not one request.
 */
export const rateLimit =
  (
    limiters: Limiters,
    accounts: Readonly<Record<string, Account>>,
  ): MiddlewareHandler<{ Variables: ClientIdVariables & RateLimitVariables }> =>
  async (c, next) => {
    if (c.req.path === health.path) {
      await next();
      return;
    }
    const prefix = ipPrefix(c.req.header("cf-connecting-ip"));
    const limiter: RateLimiter = TRANSPORT_PREFIXES.some((p) => c.req.path.startsWith(p))
      ? limiters.rpc
      : limiters.default;
    const groupKey = `${c.get("clientId")}:${prefix}`;
    const charge = async (units: number): Promise<void> => {
      if (units <= 0) {
        return;
      }
      const byIp = await limiters.ip.limit({ key: prefix, delta: units });
      const byInstall = byIp.success ? await limiter.limit({ key: groupKey, delta: units }) : byIp;
      if (!byInstall.success) {
        throw new GatewayHttpError(429, "rate-limited", RATE_LIMIT_RETRY_AFTER_SECONDS);
      }
    };
    const meter: Meter = async (account, units) => {
      if (units <= 0) {
        return;
      }
      const found = accounts[account];
      if (found === undefined) {
        // Resolved providers carry a configured account; reaching this is a construction bug.
        throw new Error(`provider account "${account}" is not configured`);
      }
      // One IP buys at most 5 % of the account's slowest per-minute window.
      const delta = Math.max(1, Math.ceil((units * 20_000) / perMinute(found)));
      if (delta > SHARE_LIMIT) {
        throw new GatewayHttpError(413, "too-costly");
      }
      // One key today — the same /24 or /48 `charge` uses; IPv6's /64 joins this loop later.
      for (const key of [prefix]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- every key must be charged in order
        const result = await limiters.share.limit({ key: `${account}:${key}`, delta });
        if (!result.success) {
          throw new GatewayHttpError(429, "rate-limited", SHARE_RETRY_AFTER_SECONDS);
        }
      }
    };
    await charge(1);
    c.set("charge", charge);
    c.set("meter", meter);
    await next();
  };
