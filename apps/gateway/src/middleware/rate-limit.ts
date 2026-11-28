import type { MiddlewareHandler } from "hono";

import { health } from "@qntx/wallet-engine/gateway/contract";

import type { Account } from "../config/accounts.ts";
import type { Limiters, RateLimiter } from "../limits.ts";
import type { Meter } from "../providers/forward.ts";
import type { ClientIdVariables } from "./client-id.ts";
import { GatewayHttpError } from "./errors.ts";

/** Matches the 60 s `period` of the Workers rate-limit bindings in wrangler.jsonc. */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/** The `SHARE_LIMITER` binding's limit: one IP's share units per account per minute. */
export const SHARE_LIMIT = 1000;
/** Matches the binding's 60-second period. */
export const SHARE_RETRY_AFTER_SECONDS = 60;
/** The share binding's longest period: only windows at this scale price the per-prefix share. */
export const SHARE_WINDOW_MAX_SECONDS = 60;

/**
 * The per-minute capacity one client prefix may spend of `account`: `clientShare` of its
 * minute-scale rate. Day/month quotas live in `cap`, enforced by the global budget (the
 * provider-budget Durable Object), not per prefix. Validates the row: throws when any rate window
 * is longer than a minute or non-positive — longer windows are token buckets that cannot hard-cap
 * anything — when the account has no rate window, when a cap value is not a positive integer, or
 * when `clientShare` falls outside (0, 1].
 */
export function sharePerMinute(account: Account): number {
  if (!(account.clientShare > 0) || account.clientShare > 1) {
    throw new Error(
      `provider account clientShare must be inside (0, 1], got ${account.clientShare}`,
    );
  }
  for (const window of account.rate) {
    if (!(window.seconds > 0) || window.seconds > SHARE_WINDOW_MAX_SECONDS) {
      throw new Error(
        `provider account rate window must be inside (0, ${String(SHARE_WINDOW_MAX_SECONDS)}] seconds, got ${String(window.seconds)}`,
      );
    }
  }
  if (account.rate.length === 0) {
    throw new Error("provider account has no minute-scale rate window for the client share");
  }
  for (const value of [account.cap?.day, account.cap?.month]) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`provider account cap must be a positive integer, got ${String(value)}`);
    }
  }
  return (
    account.clientShare *
    Math.min(...account.rate.map((window) => (window.units * 60) / window.seconds))
  );
}

/** The share-limiter units one call costing `units` account units is charged on each IP key. */
export const shareDelta = (account: Account, units: number): number =>
  Math.max(1, Math.ceil((units * SHARE_LIMIT) / sharePerMinute(account)));

/** One IPv4 octet written in decimal, no leading zeros, 0–255. */
const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** One IPv6 group: one to four hexadecimal characters. */
const IPV6_GROUP = /^[\da-fA-F]{1,4}$/;

/** The octets of a strict dotted-quad IPv4 string, or undefined when it is not one. */
const ipv4Octets = (ip: string): readonly [number, number, number, number] | undefined => {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) {
      return undefined;
    }
    octets.push(Number(part));
  }
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return [a, b, c, d];
};

/** One half of an IPv6 literal either side of `::`; a dotted-quad tail ends the address. */
const ipv6Half = (half: string, tail: boolean): number[] | undefined => {
  if (half === "") {
    return [];
  }
  const parts = half.split(":");
  const out: number[] = [];
  for (const [index, part] of parts.entries()) {
    // A dotted-quad tail is legal only as the address's last two groups.
    if (tail && index === parts.length - 1 && part.includes(".")) {
      const octets = ipv4Octets(part);
      if (octets === undefined) {
        return undefined;
      }
      const [a, b, c, d] = octets;
      out.push(a * 256 + b, c * 256 + d);
      continue;
    }
    if (!IPV6_GROUP.test(part)) {
      return undefined;
    }
    out.push(Number.parseInt(part, 16));
  }
  return out;
};

/** The eight 16-bit groups of a strictly written IPv6 address, or undefined when it is not one. */
const ipv6Groups = (ip: string): ReadonlyArray<number> | undefined => {
  const halves = ip.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const front = ipv6Half(halves[0] ?? "", halves.length === 1);
  const back = ipv6Half(halves[1] ?? "", true);
  if (front === undefined || back === undefined) {
    return undefined;
  }
  // `::` must compress at least one group — eight written groups leave it nothing to stand for.
  if (halves.length === 2 && front.length + back.length >= 8) {
    return undefined;
  }
  const groups =
    halves.length === 2
      ? [...front, ...Array.from({ length: 8 - front.length - back.length }, () => 0), ...back]
      : front;
  return groups.length === 8 ? groups : undefined;
};

/**
 * The counter keys an address is charged against, most specific first: IPv4 → its /24 — an
 * IPv4-mapped IPv6 bills the embedded address's /24 like a plain IPv4 client — IPv6 → its
 * normalized /64 and /48 (an attacker holding a /48 of subnets is still bounded by the coarse key,
 * and one /64 cannot hide among its neighbours). An absent, unparseable or unspecified address
 * yields no keys; the caller decides whether that is a shared `unknown` bucket or a rejected
 * request. The full address never reaches a counter key or a log.
 */
export function clientKeys(ip: string | undefined): readonly [string, ...string[]] | undefined {
  if (ip === undefined || ip === "") {
    return undefined;
  }
  if (!ip.includes(":")) {
    const octets = ipv4Octets(ip);
    if (octets === undefined || octets.every((octet) => octet === 0)) {
      return undefined;
    }
    const [a, b, c] = octets;
    return [`${a}.${b}.${c}.0/24`];
  }
  const groups = ipv6Groups(ip);
  if (groups === undefined || groups.every((group) => group === 0)) {
    return undefined;
  }
  // IPv4-mapped (`::ffff:a.b.c.d` or `::ffff:c633:6401`): the embedded IPv4's /24, same as plain.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    if (hi === 0 && lo === 0) {
      return undefined;
    }
    return [`${Math.floor(hi / 256)}.${hi % 256}.${Math.floor(lo / 256)}.0/24`];
  }
  const normalized = groups.map((group) => group.toString(16).padStart(4, "0"));
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
 * costs the sum of its calls, not one request. A client address that parses to no keys is the
 * shared `unknown` bucket under `optional`, or a 400 before any limiter call under `required`.
 */
export const rateLimit =
  (
    limiters: Limiters,
    accounts: Readonly<Record<string, Account>>,
    clientAddress: "required" | "optional",
  ): MiddlewareHandler<{ Variables: ClientIdVariables & RateLimitVariables }> =>
  async (c, next) => {
    if (c.req.path === health.path) {
      await next();
      return;
    }
    const parsed = clientKeys(c.req.header("cf-connecting-ip"));
    if (parsed === undefined && clientAddress === "required") {
      // The deployment promises a client address on every request (Cloudflare sets the header);
      // absent or unparseable means the request did not arrive the expected way.
      throw new GatewayHttpError(400, "invalid-request");
    }
    const keys: readonly [string, ...string[]] = parsed ?? ["unknown"];
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
