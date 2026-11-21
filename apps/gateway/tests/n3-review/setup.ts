/**
 * Shared setup for the n3-review PoC tests: the real production gateway wiring with scripted
 * upstreams and faithful rate-limit fakes (countBefore = the binding's count-before-add semantics,
 * so one call can cross the limit boundary before the next is refused).
 */
import { PRODUCTION_ACCOUNTS } from "../../src/config/accounts.ts";
import { PRODUCTION_NETWORKS } from "../../src/config/networks.ts";
import type { UpstreamAuthId, Limiters, ProviderBudget, RateLimiter } from "../../src/types.ts";
import { allowAll, countBefore, gateway, memoryPriceCache } from "../helpers.ts";

export const AUTH_IDS: ReadonlyArray<UpstreamAuthId> = [
  "alchemy",
  "drpc",
  "blockstream",
  "ankr",
  "trongrid",
  "tatum",
];

const noAuthInit = async (): Promise<Record<string, never>> => {
  await Promise.resolve();
  return {};
};

export const noAuth = (): NonNullable<Parameters<typeof gateway>[0]["auth"]> =>
  Object.fromEntries(AUTH_IDS.map((id) => [id, noAuthInit]));

export type ProductionAppOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly share?: RateLimiter;
  readonly budget?: ProviderBudget;
  readonly now?: () => number;
};

/**
 * The binding's real behaviour that `countBefore` omits: counters live inside a fixed period and
 * reset when the clock crosses a period boundary. Same count-before-add semantics (a request is
 * refused only when the window's count is already at the limit, then charged its delta anyway).
 */
export const windowedCountBefore = (
  limit: number,
  periodMs: number,
  now: () => number,
): RateLimiter => {
  const state = new Map<string, { window: number; count: number }>();
  return {
    limit: async ({ key, delta = 1 }: { key: string; delta?: number }) => {
      await Promise.resolve();
      const window = Math.floor(now() / periodMs);
      const entry = state.get(key);
      const count = entry === undefined || entry.window !== window ? 0 : entry.count;
      if (count >= limit) {
        return { success: false };
      }
      state.set(key, { window, count: count + delta });
      return { success: true };
    },
  };
};

export const productionApp = (options: ProductionAppOptions): ReturnType<typeof gateway> =>
  gateway({
    fetch: options.fetch,
    networks: PRODUCTION_NETWORKS,
    accounts: PRODUCTION_ACCOUNTS,
    auth: noAuth(),
    limiters: {
      ip: allowAll,
      rpc: allowAll,
      default: allowAll,
      share: options.share ?? countBefore(1000),
    } satisfies Limiters,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    jupiter: { apiKey: "n3-review" },
    prices: {
      cache: memoryPriceCache(),
      // Enables the CoinGecko source so the eur path runs; the key is fake.
      coingecko: { apiKey: "n3-review" },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });

export const TRON_BLOCK = {
  blockID: "a".repeat(64),
  block_header: { raw_data: { number: 1, timestamp: 1 } },
};

export const statusSeq = async (
  _app: ReturnType<typeof gateway>,
  requests: ReadonlyArray<() => Promise<Response>>,
): Promise<number[]> => {
  const statuses: number[] = [];
  for (const send of requests) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    const res = await send();
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    statuses.push(res.status);
  }
  return statuses;
};

export const counts = (statuses: ReadonlyArray<number>): Record<number, number> => {
  const out: Record<number, number> = {};
  for (const status of statuses) {
    out[status] = (out[status] ?? 0) + 1;
  }
  return out;
};

// Small helpers so test bodies stay free of conditionals (vitest/no-conditional-in-test also
// flags ?? / ?. / ?:).
export const tallyAt = (tally: Record<number, number>, status: number): number =>
  tally[status] ?? 0;

export const dash = (value: unknown): string => (typeof value === "string" ? value : "-");

export const orZero = (value: number | undefined): number => value ?? 0;

export const pricesMissing = (body: unknown): ReadonlyArray<unknown> => {
  if (
    typeof body === "object" &&
    body !== null &&
    "missing" in body &&
    Array.isArray(body.missing)
  ) {
    return body.missing as ReadonlyArray<unknown>;
  }
  return [];
};

export const smokePricesPredicate = (body: unknown, valid: boolean): boolean =>
  valid && pricesMissing(body).length === 0;
