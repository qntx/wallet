import { expect } from "vite-plus/test";

import { accepts } from "@qntx/wallet-engine/gateway/contract";

import { createGateway } from "../src/app.ts";
import { ALCHEMY_COSTS } from "../src/budget/costs.ts";
import type { Account } from "../src/config/accounts.ts";
import { PRODUCTION_ACCOUNTS } from "../src/config/accounts.ts";
import { PRODUCTION_NETWORKS } from "../src/config/networks.ts";
import type { Limiters, RateLimiter } from "../src/limits.ts";
import type { RiskStore } from "../src/risk/phishing.ts";
import type { TokenListStore } from "../src/tokens/build.ts";
import type {
  GatewayNetwork,
  PriceCache,
  ProviderBudget,
  ResolvedProvider,
  UpstreamAuthId,
} from "../src/types.ts";

export const CLIENT_ID = "0123456789abcdef0123456789abcdef";
export const SEPOLIA = "eip155:11155111";
export const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";
export const MAINNET_BITCOIN = "bip122:000000000019d6689c085ae165831e93";
export const ORIGIN = "http://localhost:5173";

export const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  [SEPOLIA, "evm"],
  [DEVNET, "sol"],
  [SIGNET, "btc"],
].map(([id = "", slug = ""]) => ({
  id,
  providers: [
    { id: "a", url: `https://a.test/${slug}` },
    { id: "b", url: `https://b.test/${slug}` },
  ],
}));

/**
 * Every provider id the test networks and the code-built providers use, billed one request credit
 * each against a budget no test can exhaust. `alchemy` prices by compute units so the history
 * route's `alchemy_getAssetTransfers` cost resolves.
 */
export const TEST_ACCOUNTS: Readonly<Record<string, Account>> = {
  ...Object.fromEntries(
    [
      "a",
      "b",
      "drpc",
      "blockstream",
      "bs",
      "dead",
      "fake",
      "keyed",
      "never",
      "other",
      "plain",
      "coingecko",
      "defillama",
      "0x",
      "jupiter",
      "across",
      "trongrid",
      "ankr",
      "tatum",
    ].map((id) => [
      id,
      {
        costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
        budget: [{ units: 1_000_000, seconds: 60 }],
        clientShare: 0.05,
        source: "https://test.invalid",
      } satisfies Account,
    ]),
  ),
  alchemy: {
    costs: ALCHEMY_COSTS,
    budget: [{ units: 1_000_000, seconds: 60 }],
    clientShare: 0.05,
    source: "https://test.invalid",
  },
};

/** A code-built provider fake: id is its account, one request credit per call. */
export const testProvider = (id: string, url = `https://${id}.test`): ResolvedProvider => ({
  id,
  url,
  account: id,
  costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
});

export type UpstreamCall = {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headers: HeadersInit | undefined;
};
export type Upstream = (call: UpstreamCall, signal: AbortSignal) => Response | Promise<Response>;

/** Fake `fetch`: routes by URL prefix to scripted handlers and records every call. */
export function fakeFetch(handlers: Record<string, Upstream>): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: UpstreamCall[];
  readonly callsTo: (prefix: string) => UpstreamCall[];
} {
  const calls: UpstreamCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers: init?.headers,
    };
    calls.push(call);
    const key = Object.keys(handlers).find((prefix) => url.startsWith(prefix));
    if (key === undefined) {
      throw new TypeError(`no fake upstream for ${url}`);
    }
    const handler = handlers[key];
    if (handler === undefined) {
      throw new TypeError("unreachable");
    }
    return handler(call, init?.signal ?? new AbortController().signal);
  };
  return { fetch, calls, callsTo: (prefix) => calls.filter((c) => c.url.startsWith(prefix)) };
}

export const rpcOk = (result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, result });

export const rpcFailure = (code: number, message: string): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } });

const decide = async (success: boolean): Promise<{ success: boolean }> => {
  await Promise.resolve();
  return { success };
};

export const allowAll: RateLimiter = { limit: async () => decide(true) };
export const denyAll: RateLimiter = { limit: async () => decide(false) };

/** A budget that never refuses — the default for tests not exercising account quotas. */
export const openBudget: ProviderBudget = {
  take: async () => {
    await Promise.resolve();
    return { ok: true };
  },
};

export function recordingLimiter(): RateLimiter & {
  readonly keys: string[];
  readonly deltas: number[];
} {
  const keys: string[] = [];
  const deltas: number[] = [];
  return {
    keys,
    deltas,
    limit: async ({ key, delta }: { key: string; delta?: number }) => {
      keys.push(key);
      deltas.push(delta ?? 1);
      return decide(true);
    },
  };
}

/** Faithful binding fake: decides on the count before the call; a refused call adds nothing. */
export function countBefore(limit: number): RateLimiter & {
  readonly counts: ReadonlyMap<string, number>;
} {
  const counts = new Map<string, number>();
  return {
    counts,
    limit: async ({ key, delta = 1 }: { key: string; delta?: number }) => {
      const count = counts.get(key) ?? 0;
      if (count >= limit) {
        return decide(false);
      }
      counts.set(key, count + delta);
      return decide(true);
    },
  };
}

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

export function memoryRiskStore(): RiskStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => {
      await Promise.resolve();
      return data.get(key);
    },
    put: async (key, value) => {
      await Promise.resolve();
      data.set(key, value);
    },
  };
}

/** In-memory price cache; records each `put` TTL so a test can assert the cache lifetime. */
export function memoryPriceCache(): PriceCache & {
  readonly data: Map<string, string>;
  readonly ttls: number[];
} {
  const data = new Map<string, string>();
  const ttls: number[] = [];
  return {
    data,
    ttls,
    get: async (key) => {
      await Promise.resolve();
      return data.get(key);
    },
    put: async (key, value, ttlSeconds) => {
      await Promise.resolve();
      data.set(key, value);
      ttls.push(ttlSeconds);
    },
  };
}

export function gateway(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly networks?: ReadonlyArray<GatewayNetwork>;
  readonly risk?: RiskStore;
  readonly tokens?: TokenListStore;
  readonly tokenNetworks?: ReadonlySet<string>;
  readonly limiters?: Limiters;
  readonly accounts?: Readonly<Record<string, Account>>;
  readonly budget?: ProviderBudget;
  readonly clientAddress?: "required" | "optional";
  readonly zeroEx?: { apiKey: string; fee?: { recipient: string; bps: number } };
  readonly auth?: Parameters<typeof createGateway>[0]["auth"];
  readonly jupiter?: { apiKey: string };
  readonly log?: (line: string) => void;
  readonly prices?: Parameters<typeof createGateway>[0]["prices"];
  readonly push?: Parameters<typeof createGateway>[0]["push"];
  readonly now?: () => number;
}): ReturnType<typeof createGateway> {
  return createGateway({
    fetch: options.fetch,
    networks: options.networks ?? NETWORKS,
    limiters: options.limiters ?? {
      ip: allowAll,
      rpc: allowAll,
      default: allowAll,
      share: allowAll,
    },
    accounts: options.accounts ?? TEST_ACCOUNTS,
    budget: options.budget ?? openBudget,
    clientAddress: options.clientAddress ?? "optional",
    corsOrigins: [ORIGIN],
    risk: options.risk ?? memoryRiskStore(),
    tokens: options.tokens ?? memoryRiskStore(),
    tokenNetworks:
      options.tokenNetworks ?? new Set((options.networks ?? NETWORKS).map((n) => n.id)),
    auth: options.auth ?? {},
    prices: options.prices ?? { cache: memoryPriceCache() },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.zeroEx === undefined ? {} : { zeroEx: options.zeroEx }),
    ...(options.jupiter === undefined ? {} : { jupiter: options.jupiter }),
    ...(options.push === undefined ? {} : { push: options.push }),
    log: options.log ?? (() => undefined),
  });
}

export const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  "x-client-id": CLIENT_ID,
  ...extra,
});

const UPSTREAM_AUTH_IDS: ReadonlyArray<UpstreamAuthId> = [
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

/** Every upstream auth id resolves to no headers — the keyed endpoints stay construction-valid. */
const noAuth = (): NonNullable<Parameters<typeof gateway>[0]["auth"]> =>
  Object.fromEntries(UPSTREAM_AUTH_IDS.map((id) => [id, noAuthInit]));

/** A minimal `getnowblock` body satisfying the TRON node schema. */
export const TRON_BLOCK = {
  blockID: "a".repeat(64),
  block_header: { raw_data: { number: 1, timestamp: 1 } },
};

export type ProductionGatewayOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly share?: RateLimiter;
  readonly budget?: ProviderBudget;
  readonly now?: () => number;
};

/**
 * The production gateway wiring in-process: real production networks and account table, fake auth,
 * scripted upstreams and faithful share-limit fakes, so tests exercise the configured provider rows
 * rather than a parallel fixture.
 */
export const productionGateway = (options: ProductionGatewayOptions): ReturnType<typeof gateway> =>
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
    },
    jupiter: { apiKey: "gateway-test" },
    prices: {
      cache: memoryPriceCache(),
      // Enables the CoinGecko source so the non-USD path runs; the key is fake.
      coingecko: { apiKey: "gateway-test" },
    },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

export const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: headers({ "content-type": "application/json" }),
  body: typeof body === "string" ? body : JSON.stringify(body),
});

export const call = (
  method: string,
  params: unknown[] = [],
  id = 1,
): { jsonrpc: "2.0"; id: number; method: string; params: unknown[] } => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

export async function expectContract(
  res: Response,
  schema: Parameters<typeof accepts>[0],
): Promise<unknown> {
  const body: unknown = await res.clone().json();
  expect(accepts(schema, body), JSON.stringify(body)).toBe(true);
  return body;
}
