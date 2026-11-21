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
/** The share binding's longest period: only windows at this scale price the per-prefix share. */
export const SHARE_WINDOW_MAX_SECONDS = 60;

/**
 * The per-minute capacity one client prefix may spend of `account`: `clientShare` of its
 * minute-scale budget. Windows longer than a minute stay out — day/month quotas are enforced by the
 * global budget (the provider-budget Durable Object), not per prefix. Throws when the account has
 * no minute-scale window or a `clientShare` outside (0, 1].
 */
export function sharePerMinute(account: Account): number {
  if (!(account.clientShare > 0) || account.clientShare > 1) {
    throw new Error(
      `provider account clientShare must be inside (0, 1], got ${account.clientShare}`,
    );
  }
  const windows = account.budget.filter((window) => window.seconds <= SHARE_WINDOW_MAX_SECONDS);
  if (windows.length === 0) {
    throw new Error("provider account has no minute-scale budget window for the client share");
  }
  return (
    account.clientShare * Math.min(...windows.map((window) => (window.units * 60) / window.seconds))
  );
}

/** The share-limiter units one call costing `units` account units is charged on each IP key. */
export const shareDelta = (account: Account, units: number): number =>
  Math.max(1, Math.ceil((units * SHARE_LIMIT) / sharePerMinute(account)));

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

const TRANSPORT_PREFIXES = ["/v1/rpc/", "/v1/esplora/", "/v1/tron/"];

export type RateLimitVariables = {
  /**
   * Charges `units` more on this request's limiter keys (every IP key, then client id + most
   * specific key); throws `429 rate-limited` when any refuses. `units <= 0` is a no-op.
   */
  charge: (units: number) => Promise<void>;
  /**
   * Bills `units` of a provider account's own cost unit to this request's share of that account
   * (`account:` + each IP key on the share limiter; all are charged and all must succeed). Refuses
   * `rate-limited` when the share is spent and `too-costly` when one delta exceeds the whole client
   * window — before any limiter call. A refusal is provider-local: the forwarder decides whether
   * another provider can still serve the request.
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
      const found = accounts[account];
      if (found === undefined) {
        // Resolved providers carry a configured account; reaching this is a construction bug.
        throw new Error(`provider account "${account}" is not configured`);
      }
      // One IP buys at most clientShare of the account's minute-scale budget.
      const delta = shareDelta(found, units);
      if (delta > SHARE_LIMIT) {
        return { ok: false, reason: "too-costly" };
      }
      for (const key of keys) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- every key must be charged in order
        const result = await limiters.share.limit({ key: `${account}:${key}`, delta });
        if (!result.success) {
          return {
            ok: false,
            reason: "rate-limited",
            retryAfterSeconds: SHARE_RETRY_AFTER_SECONDS,
          };
        }
      }
      return { ok: true };
    };
    await charge(1);
    c.set("charge", charge);
    c.set("meter", meter);
    await next();
  };
