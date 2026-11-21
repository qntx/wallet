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
/** Fraction of an account's slowest per-minute budget one IP may consume. */
const SHARE_OF_ACCOUNT = 0.05;

/** The slowest of an account's windows, expressed as units per minute. */
const perMinute = (account: Account): number =>
  Math.min(...account.budget.map((window) => (window.units * 60) / window.seconds));

/**
 * The counter keys an address is charged against, most specific first: IPv4 → its /24, IPv6 → its
 * normalized /64 and /48 (an attacker holding a /48 of subnets is still bounded by the coarse key,
 * and one /64 cannot hide among its neighbours). Unknown → ["unknown"]. The full address never
 * reaches a counter key or a log.
 */
export function ipKeys(ip: string | undefined): readonly [string, ...string[]] {
  if (ip === undefined || ip === "") {
    return ["unknown"];
  }
  if (!ip.includes(":")) {
    const octets = ip.split(".");
    return octets.length === 4 ? [`${octets.slice(0, 3).join(".")}.0/24`] : ["unknown"];
  }
  const [head = "", tail] = ip.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array.from({ length: 8 - front.length - back.length }, () => "0"), ...back];
  const normalized = groups.map((g) => g.toLowerCase().padStart(4, "0"));
  return [`${normalized.slice(0, 4).join(":")}::/64`, `${normalized.slice(0, 3).join(":")}::/48`];
}

const TRANSPORT_PREFIXES = ["/v1/rpc/", "/v1/esplora/"];

export type RateLimitVariables = {
  /**
   * Charges `units` more on this request's limiter keys (every IP key, then client id + most
   * specific key); throws `429 rate-limited` when any refuses. `units <= 0` is a no-op.
   */
  charge: (units: number) => Promise<void>;
  /**
   * Bills `units` of a provider account's own cost unit to this request's share of that account
   * (`account:` + each IP key on the share limiter; all are charged and all must succeed). Throws
   * `429 rate-limited` when the share is spent and `413 too-costly` when one delta exceeds the
   * whole client window — before any limiter call.
   */
  meter: Meter;
};

/**
 * Two counters per request, health exempt: every key the IP claims (its /24, or both its /64 and
 * /48 for IPv6) on the flood limiter first — client ids are chosen by the client, so this is the
 * only bound a script rotating them meets — then "client id + most specific key" in the group's
 * binding (transport routes use the RPC limiter, everything else the default). Either refusing
 * answers 429 with `Retry-After`. Routes charge extra units through the `charge` variable: a batch
 * costs the sum of its calls, not one request.
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
    const keys = ipKeys(c.req.header("cf-connecting-ip"));
    const limiter: RateLimiter = TRANSPORT_PREFIXES.some((p) => c.req.path.startsWith(p))
      ? limiters.rpc
      : limiters.default;
    const groupKey = `${c.get("clientId")}:${keys[0]}`;
    const charge = async (units: number): Promise<void> => {
      if (units <= 0) {
        return;
      }
      const byIp = await Promise.all(
        keys.map(async (key) => limiters.ip.limit({ key, delta: units })),
      );
      const byInstall = byIp.every((result) => result.success)
        ? await limiter.limit({ key: groupKey, delta: units })
        : { success: false };
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
      // One IP buys at most SHARE_OF_ACCOUNT of the account's slowest per-minute window.
      const delta = Math.max(
        1,
        Math.ceil((units * SHARE_LIMIT) / (SHARE_OF_ACCOUNT * perMinute(found))),
      );
      if (delta > SHARE_LIMIT) {
        throw new GatewayHttpError(413, "too-costly");
      }
      for (const key of keys) {
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
