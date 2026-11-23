import { randomBytes } from "node:crypto";
/**
 * The harness: a real in-process gateway on the production account table in front of a real engine,
 * with the limiter/budget readouts a capacity report needs — every gateway request by route class
 * and status, every upstream call by billing account, every budget unit, and the largest
 * share-delta sum one share key accumulated (the per-prefix share is what one wallet's /24 may
 * spend per minute).
 */
import { readFileSync } from "node:fs";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { createGateway } from "../../../../apps/gateway/src/app.ts";
import { localBudget } from "../../../../apps/gateway/src/budget/local.ts";
import { PRODUCTION_ACCOUNTS } from "../../../../apps/gateway/src/config/accounts.ts";
import { PRODUCTION_NETWORKS } from "../../../../apps/gateway/src/config/networks.ts";
import type { Limiters, RateLimiter } from "../../../../apps/gateway/src/limits.ts";
import { buildTokenLists } from "../../../../apps/gateway/src/tokens/build.ts";
import type { TokenListStore } from "../../../../apps/gateway/src/tokens/build.ts";
import { tokenListSources } from "../../../../apps/gateway/src/tokens/sources.ts";
import { createWalletEngine } from "../../src/engine.ts";
import type { WalletEngine } from "../../src/engine.ts";
import { gatewayScope } from "../../src/gateway/client.ts";
import { CLIENT_ID_HEADER, PROVIDER_PIN_HEADER } from "../../src/gateway/contract/index.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../../src/store/memory.ts";
import type { HostUpstream, Stub, WalletModel } from "./upstream.ts";
import {
  HOST_SOLANA_URL,
  HOST_TRON_URL,
  hostUpstream,
  stubUpstream,
  tokenListFetch,
} from "./upstream.ts";

export const CLIENT_IP = "203.0.113.10";
const GATEWAY_URL = "https://gateway.test";
const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
export const VERIFY = { kind: "password" as const, password: PASSWORD };
export const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const WRANGLER = new URL("../../../../apps/gateway/wrangler.jsonc", import.meta.url);

export const TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Reads a string field off a loosely typed account response ("" when absent). */
const strField = (v: unknown, key: string): string => {
  const field = isObj(v) ? v[key] : undefined;
  return typeof field === "string" ? field : "";
};

/** The wrangler.jsonc production rate-limit rows, comments and trailing commas stripped. */
export const productionLimits = (): Readonly<Record<string, { limit: number; period: number }>> => {
  const raw = readFileSync(WRANGLER, "utf8");
  // Strip `//` comments only outside string literals, then drop trailing commas.
  let inString = false;
  let stripped = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '"' && raw[i - 1] !== "\\") {
      inString = !inString;
      stripped += c;
      continue;
    }
    if (!inString && c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") {
        i += 1;
      }
      stripped += "\n";
      continue;
    }
    stripped += c;
  }
  const text = stripped.replaceAll(/,(\s*[}\]])/g, "$1");
  const doc: unknown = JSON.parse(text);
  const ratelimits =
    isObj(doc) && isObj(doc["env"]) && isObj(doc["env"]["production"])
      ? doc["env"]["production"]["ratelimits"]
      : undefined;
  const out: Record<string, { limit: number; period: number }> = {};
  for (const row of Array.isArray(ratelimits) ? ratelimits.filter(isObj) : []) {
    const { name } = row;
    const simple = isObj(row["simple"]) ? row["simple"] : {};
    if (
      typeof name === "string" &&
      typeof simple["limit"] === "number" &&
      typeof simple["period"] === "number"
    ) {
      out[name] = { limit: simple["limit"], period: simple["period"] };
    }
  }
  return out;
};

/** The helpers.ts windowed limiter — engine tests cannot import gateway test code, so it is copied. */
export const windowedCountBefore = (
  limit: number,
  periodMs: number,
  now: () => number,
  report?: (key: string, count: number) => void,
  unconstrained = false,
): RateLimiter => {
  const state = new Map<string, { window: number; count: number }>();
  return {
    limit: async ({ key, delta = 1 }: { key: string; delta?: number }) => {
      await Promise.resolve();
      const window = Math.floor(now() / periodMs);
      const entry = state.get(key);
      const count = entry === undefined || entry.window !== window ? 0 : entry.count;
      if (!unconstrained && count >= limit) {
        return { success: false };
      }
      const next = count + delta;
      state.set(key, { window, count: next });
      report?.(key, next);
      return { success: true };
    },
  };
};

/** The billing account a provider URL belongs to: `auth ?? id` for network rows, else the code path. */
export const providerPrefixes = (
  networks: ReadonlyArray<{ providers: ReadonlyArray<{ id: string; url: string; auth?: string }> }>,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const network of networks) {
    for (const provider of network.providers) {
      map.set(provider.url, provider.auth ?? provider.id);
    }
  }
  map.set("https://pro-api.coingecko.com", "coingecko");
  map.set("https://coins.llama.fi", "defillama");
  map.set("https://api.0x.org", "0x");
  map.set("https://api.jup.ag", "jupiter");
  map.set("https://app.across.to", "across");
  map.set("https://login.blockstream.com", "blockstream");
  return map;
};

export type RouteClass =
  | "rpc"
  | "esplora"
  | "tron"
  | "history"
  | "tokens"
  | "prices"
  | "quotes"
  | "networks"
  | "eligibility"
  | "risk"
  | "other";

const parsePricesBody = (
  body: string | ArrayBuffer | undefined,
): { assets: ReadonlyArray<string>; currency: string } => {
  try {
    const text =
      typeof body === "string" ? body : body === undefined ? "" : new TextDecoder().decode(body);
    const parsed: unknown = JSON.parse(text);
    const assets =
      isObj(parsed) && Array.isArray(parsed["assets"])
        ? parsed["assets"].flatMap((a) => (typeof a === "string" ? [a] : []))
        : [];
    const currency =
      isObj(parsed) && typeof parsed["currency"] === "string" ? parsed["currency"] : "";
    return { assets, currency };
  } catch {
    return { assets: [], currency: "" };
  }
};

export const routeClass = (pathname: string): RouteClass => {
  if (pathname.startsWith("/v1/rpc/")) {
    return "rpc";
  }
  if (pathname.startsWith("/v1/esplora/")) {
    return "esplora";
  }
  if (pathname.startsWith("/v1/tron/")) {
    return "tron";
  }
  if (pathname.startsWith("/v1/history/")) {
    return "history";
  }
  if (pathname.startsWith("/v1/tokens/")) {
    return "tokens";
  }
  if (pathname.startsWith("/v1/prices/")) {
    return "prices";
  }
  if (pathname.startsWith("/v1/quotes")) {
    return "quotes";
  }
  if (pathname.startsWith("/v1/networks")) {
    return "networks";
  }
  if (pathname.startsWith("/v1/eligibility")) {
    return "eligibility";
  }
  if (pathname.startsWith("/v1/risk")) {
    return "risk";
  }
  return "other";
};

/** One `POST /v1/prices/:family` request as measured — its assets, what the gateway cache answered. */
export type PricesRead = {
  readonly assets: ReadonlyArray<string>;
  readonly currency: string;
  readonly status: number;
  readonly providers: ReadonlyArray<string>;
  /** Distinct asked assets a live cache entry answered — the rest went upstream or missed. */
  readonly cached: number;
  /** `prices:*` stub calls by account, attributed to this request's window. */
  readonly upstream: Readonly<Record<string, number>>;
};

export type Readings = {
  readonly routes: Map<string, number>;
  readonly statuses: Map<number, number>;
  /** `${route}|${status}` → attempts — refused attempts counted like `statuses`. */
  readonly routeStatuses: Map<string, number>;
  /** `${route}|${method} ${normalized path}` → requests — scripthashes collapsed to `:h`. */
  readonly routePaths: Map<string, number>;
  readonly upstream: Map<string, { calls: number; units: number }>;
  readonly budget: Map<string, number>;
  readonly share: Map<string, number>;
  /** Route → gateway requests carrying `x-gateway-provider` (the pinned path ran). */
  readonly pinned: Map<string, number>;
  /** `host-solana`/`host-tron` → host-endpoint call count — cross-check reads, never upstream. */
  readonly host: Map<string, number>;
  readonly prices: PricesRead[];
  /** Every accepted limiter take's post-take windowed count — per-limiter maxima come from this. */
  readonly limiterTakes: ReadonlyArray<{ limiter: string; key: string; count: number }>;
  /** Every budget take with its timestamp — sliding-window burst maxima come from this. */
  readonly takes: ReadonlyArray<{ account: string; units: number; at: number }>;
  /** `x-client-id` → gateway scope, seen on requests — decodes `clientId:prefix` limiter keys. */
  readonly clientScopes: ReadonlyMap<string, string>;
};

export const emptyReadings = (): Readings => ({
  routes: new Map(),
  statuses: new Map(),
  routeStatuses: new Map(),
  routePaths: new Map(),
  upstream: new Map(),
  budget: new Map(),
  share: new Map(),
  pinned: new Map(),
  host: new Map(),
  prices: [],
  limiterTakes: [],
  takes: [],
  clientScopes: new Map(),
});

export type World = {
  readonly engine: WalletEngine;
  readonly walletId: string;
  readonly stub: Stub;
  /** The host-endpoint stub answering `rpc:` Solana/TRON origins — the independent cross-check. */
  readonly host: HostUpstream;
  readonly readings: Readings;
  /** In-flight gateway requests — cold-start waits for 500 ms of quiet. */
  readonly inflight: () => number;
  /** Advances the virtual limiter clock `ms` into fresh windows; irrelevant when unconstrained. */
  readonly advance: (ms: number) => void;
  /** The virtual limiter clock's reading — refusals and `advance` move it. */
  readonly clock: () => number;
  /**
   * `n` trongrid node-API calls under a foreign client IP: they spend the shared global budget (12
   * calls / 5 s) without touching this world's client share — other tenants' load.
   */
  readonly pressureTron: (n: number) => Promise<void>;
  readonly snapshot: () => Readings;
  /** `x-client-id` → gateway scope, seen on requests — decodes `clientId:prefix` limiter keys. */
  readonly clientScopes: Map<string, string>;
};

const deepCopy = <K, T>(m: ReadonlyMap<K, T>): Map<K, T> => new Map(m);

export const snapshotOf = (r: Readings): Readings => ({
  routes: deepCopy(r.routes),
  statuses: deepCopy(r.statuses),
  routeStatuses: deepCopy(r.routeStatuses),
  routePaths: deepCopy(r.routePaths),
  upstream: new Map([...r.upstream].map(([k, v]) => [k, { ...v }])),
  budget: deepCopy(r.budget),
  share: deepCopy(r.share),
  pinned: deepCopy(r.pinned),
  host: deepCopy(r.host),
  prices: [...r.prices],
  limiterTakes: [...r.limiterTakes],
  takes: [...r.takes],
  clientScopes: deepCopy(r.clientScopes),
});

export const diffReadings = (after: Readings, before: Readings): Readings => ({
  routes: new Map([...after.routes].map(([k, v]) => [k, v - (before.routes.get(k) ?? 0)] as const)),
  statuses: new Map(
    [...after.statuses].map(([k, v]) => [k, v - (before.statuses.get(k) ?? 0)] as const),
  ),
  routeStatuses: new Map(
    [...after.routeStatuses].map(([k, v]) => [k, v - (before.routeStatuses.get(k) ?? 0)] as const),
  ),
  routePaths: new Map(
    [...after.routePaths].map(([k, v]) => [k, v - (before.routePaths.get(k) ?? 0)] as const),
  ),
  upstream: new Map(
    [...after.upstream].map(([k, v]) => [
      k,
      {
        calls: v.calls - (before.upstream.get(k)?.calls ?? 0),
        units: v.units - (before.upstream.get(k)?.units ?? 0),
      },
    ]),
  ),
  budget: new Map([...after.budget].map(([k, v]) => [k, v - (before.budget.get(k) ?? 0)] as const)),
  share: new Map([...after.share].map(([k, v]) => [k, v - (before.share.get(k) ?? 0)] as const)),
  pinned: new Map([...after.pinned].map(([k, v]) => [k, v - (before.pinned.get(k) ?? 0)] as const)),
  host: new Map([...after.host].map(([k, v]) => [k, v - (before.host.get(k) ?? 0)] as const)),
  prices: after.prices.slice(before.prices.length),
  limiterTakes: after.limiterTakes.slice(before.limiterTakes.length),
  takes: after.takes.slice(before.takes.length),
  clientScopes: after.clientScopes,
});

const memoryStore = (): TokenListStore => {
  const data = new Map<string, string>();
  return {
    // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
    get: async (k) => data.get(k),
    // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
    put: async (k, v) => {
      data.set(k, v);
    },
  };
};

/** One shared wallet for the whole suite — wallet boot is the slow part; engines differ. */
export const createHarnessWallet = async (): Promise<{
  readonly wallet: Awaited<ReturnType<typeof createNodeWallet>>;
  readonly walletId: string;
}> => {
  const wallet = await createNodeWallet({
    verifyEvent,
    passkey: {
      rpId: "qntx.test",
      rpName: "qntx",
      walletSalt: "qntx/wallet",
      backupSalt: "qntx/backup",
      vaultSalt: "qntx/vault",
    },
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  const info = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: VERIFY,
  });
  return { wallet, walletId: info.walletId };
};

/**
 * Creates the in-process gateway on the production table with every measurement tap wired: share
 * and budget wrap the real limiter/local-budget, the engine-bound fetch records route classes and
 * statuses, and `stub` records upstream calls per billing account.
 */
export const createWorld = async (opts: {
  readonly wallet: Awaited<ReturnType<typeof createNodeWallet>>;
  readonly model: WalletModel;
  readonly networks?: ReadonlyArray<(typeof PRODUCTION_NETWORKS)[number]>;
  readonly tronAddress?: string;
  /** `EngineOptions.rpc` — host endpoints for the cross-checks; `{}` is a gateway-only host. */
  readonly rpc?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** "off": every limiter/budget accepts and only records — raw demand, no refusals or retries. */
  readonly unconstrained?: boolean;
  /**
   * Let 429/503 refusals on TRON node-API routes reach the engine instead of absorbing them: the
   * virtual clock still advances by the announced wait, but the refusal goes back so the engine's
   * own pinned-read retry (item E) is what waits and retries.
   */
  readonly passthroughTron?: boolean;
}): Promise<World> => {
  const networks = opts.networks ?? PRODUCTION_NETWORKS;
  // The limiter/budget clock is fake: a refusal advances it by the announced wait instead of
  // real time, so a burst that hits a production window becomes instant virtual minutes, not a
  // 20-minute test. Refused calls are still recorded in statuses — the table shows them.
  const unconstrained = opts.unconstrained === true;
  let nowMs = Date.now();
  // Unconstrained runs get the real clock: no refusals ever advance the fake one, and the burst
  // windows then read the engine's actual pacing.
  const now = unconstrained ? () => Date.now() : () => nowMs;
  const limits = productionLimits();
  const stub = stubUpstream(opts.model, providerPrefixes(networks), opts.tronAddress ?? "");
  // The engine's own endpoints for the chain-binding cross-checks: same model, recorded apart.
  const host = hostUpstream(opts.model, opts.tronAddress ?? "", stub.unstubbed);

  const limiterTakes: Array<{ limiter: string; key: string; count: number }> = [];
  const reportCount =
    (limiter: string) =>
    (key: string, count: number): void => {
      limiterTakes.push({ limiter, key, count });
    };
  const shareCalls: Array<{ key: string; delta: number }> = [];
  const shareInner = windowedCountBefore(
    limits["SHARE_LIMITER"]?.limit ?? 1000,
    60_000,
    now,
    reportCount("share"),
    unconstrained,
  );
  const share: RateLimiter = {
    limit: async ({ key, delta = 1 }) => {
      shareCalls.push({ key, delta });
      return shareInner.limit({ key, delta });
    },
  };
  const limiters: Limiters = {
    ip: windowedCountBefore(
      limits["IP_LIMITER"]?.limit ?? 300,
      10_000,
      now,
      reportCount("ip"),
      unconstrained,
    ),
    rpc: windowedCountBefore(
      limits["RPC_LIMITER"]?.limit ?? 100,
      10_000,
      now,
      reportCount("rpc"),
      unconstrained,
    ),
    default: windowedCountBefore(
      limits["DEFAULT_LIMITER"]?.limit ?? 50,
      10_000,
      now,
      reportCount("default"),
      unconstrained,
    ),
    share,
  };

  const budgetTakes: Array<{ account: string; units: number; at: number }> = [];
  const budgetInner = localBudget(PRODUCTION_ACCOUNTS, now);
  const budget = {
    take: async (account: string, units: number) => {
      budgetTakes.push({ account, units, at: now() });
      return unconstrained ? { ok: true as const } : budgetInner.take(account, units);
    },
  };

  const tokens = memoryStore();
  const tokenNetworks = new Set(
    tokenListSources({ coingecko: "k", jupiter: "k" }).flatMap((s) => s.networks),
  );
  await buildTokenLists({
    fetch: tokenListFetch,
    store: tokens,
    now,
    log: () => undefined,
    sources: tokenListSources({ coingecko: "k", jupiter: "k" }),
  });

  const risk = {
    // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
    get: async () => undefined,
    // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
    put: async () => undefined,
  };
  // The price cache is a real memory store — entries carry their `expiresAt` and the gateway's
  // own `now` judges them — instrumented so a prices request can count its cache hits.
  const priceCacheData = new Map<string, string>();
  const priceCacheLog: Array<{ key: string; hit: boolean }> = [];
  const priceCache = {
    // oxlint-disable-next-line typescript/require-await -- the cache seam's signature is a promise
    get: async (key: string) => {
      const value = priceCacheData.get(key);
      priceCacheLog.push({ key, hit: value !== undefined });
      return value;
    },
    // oxlint-disable-next-line typescript/require-await -- the cache seam's signature is a promise
    put: async (key: string, value: string, _ttl: number) => {
      priceCacheData.set(key, value);
    },
  };
  const app = createGateway({
    fetch: stub.fetch,
    networks,
    tokenNetworks,
    accounts: PRODUCTION_ACCOUNTS,
    limiters,
    clientAddress: "required",
    corsOrigins: [],
    risk,
    tokens,
    nfts: { cache: priceCache },
    prices: { cache: priceCache, coingecko: { apiKey: "stub" } },
    budget,
    auth: {
      // oxlint-disable-next-line typescript/require-await -- the auth seam's signature is a promise
      alchemy: async () => ({ authorization: "Bearer stub" }),
      // oxlint-disable-next-line typescript/require-await -- the auth seam's signature is a promise
      drpc: async () => ({ "Drpc-Key": "stub" }),
      // oxlint-disable-next-line typescript/require-await -- the auth seam's signature is a promise
      ankr: async () => ({ "x-api-key": "stub" }),
      // oxlint-disable-next-line typescript/require-await -- the auth seam's signature is a promise
      blockstream: async () => ({ authorization: "Bearer stub" }),
      // oxlint-disable-next-line typescript/require-await -- the auth seam's signature is a promise
      trongrid: async () => ({ "TRON-PRO-API-KEY": "stub" }),
      // oxlint-disable-next-line typescript/require-await -- the auth seam's signature is a promise
      tatum: async () => ({ "x-api-key": "stub" }),
    },
    jupiter: { apiKey: "stub" },
    zeroEx: { apiKey: "stub" },
    log: () => undefined,
  });

  const readings = emptyReadings();
  const clientScopes = new Map<string, string>();
  let inflight = 0;
  const engineFetch: typeof globalThis.fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target);
    if (url.origin === HOST_SOLANA_URL || url.origin === HOST_TRON_URL) {
      return host.fetch(input, init);
    }
    if (url.origin !== GATEWAY_URL) {
      return stub.fetch(input, init);
    }
    const clientId =
      (init?.headers === undefined ? undefined : new Headers(init.headers).get(CLIENT_ID_HEADER)) ??
      (input instanceof Request ? input.headers.get(CLIENT_ID_HEADER) : undefined);
    if (clientId !== null && clientId !== undefined) {
      clientScopes.set(clientId, gatewayScope(url));
    }
    const path = url.pathname;
    const route = routeClass(path);
    readings.routes.set(route, (readings.routes.get(route) ?? 0) + 1);
    const pin =
      (init?.headers === undefined
        ? undefined
        : new Headers(init.headers).get(PROVIDER_PIN_HEADER)) ??
      (input instanceof Request ? input.headers.get(PROVIDER_PIN_HEADER) : undefined);
    if (pin !== null && pin !== undefined) {
      readings.pinned.set(route, (readings.pinned.get(route) ?? 0) + 1);
    }
    inflight += 1;
    try {
      const headers = new Headers(init?.headers);
      headers.set("cf-connecting-ip", CLIENT_IP);
      const reqInit: { method: string; headers: Headers; body?: ArrayBuffer | string } = {
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers,
      };
      const normPath = path.replaceAll(/[0-9a-f]{64}/g, ":h");
      const routePathKey = `${route}|${reqInit.method} ${normPath}`;
      readings.routePaths.set(routePathKey, (readings.routePaths.get(routePathKey) ?? 0) + 1);
      const rawBody =
        init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined);
      if (typeof rawBody === "string") {
        reqInit.body = rawBody;
      } else if (rawBody instanceof ArrayBuffer) {
        reqInit.body = rawBody;
      }
      // Transient limiter refusals become virtual latency, not rejections: retry inside the
      // wrapper so no engine caller (foreground or background) ever fails on a window. Every
      // attempt — including the refusals — is recorded in statuses.
      const recordStatus = (status: number): void => {
        readings.statuses.set(status, (readings.statuses.get(status) ?? 0) + 1);
        const k = `${route}|${String(status)}`;
        readings.routeStatuses.set(k, (readings.routeStatuses.get(k) ?? 0) + 1);
      };
      // A prices request measures its own cache use: stub calls and cache gets made inside its
      // window are attributed to it (overlapping requests may add their calls to the window too).
      const pricesProbe =
        route === "prices"
          ? {
              start: stub.calls.length,
              cacheStart: priceCacheLog.length,
              request: parsePricesBody(reqInit.body),
            }
          : undefined;
      let res = await app.request(`${path}${url.search}`, reqInit);
      recordStatus(res.status);
      // 429 (share/limiter refusal) and 503 (budget-window exhaustion on a single-provider
      // network) are both window waits: advance the limiter clock by the announced wait (or one
      // share window) and ask again. A deterministic refusal (413 too-costly, 4xx) is returned
      // as-is — retrying it would spin forever.
      for (let retry = 0; retry < 60 && (res.status === 429 || res.status === 503); retry += 1) {
        const announced = Number(res.headers.get("retry-after") ?? "60");
        nowMs += Math.max(1, announced) * 1000;
        /* The announced wait still moves the limiter clock when the refusal is the engine's to
           retry — the refusal goes back so pinnedTronCaller's own retry handles it. */
        if (opts.passthroughTron === true && route === "tron") {
          return res;
        }
        // oxlint-disable-next-line no-await-in-loop -- bounded sequential retry
        res = await app.request(`${path}${url.search}`, reqInit);
        recordStatus(res.status);
      }
      if (pricesProbe !== undefined) {
        const upstream: Record<string, number> = {};
        for (const c of stub.calls.slice(pricesProbe.start)) {
          if (c.method.startsWith("prices:")) {
            upstream[c.account] = (upstream[c.account] ?? 0) + 1;
          }
        }
        const asked = new Set(pricesProbe.request.assets);
        const cached = new Set(
          priceCacheLog
            .slice(pricesProbe.cacheStart)
            .filter((l) => l.hit && asked.has(l.key.slice(l.key.indexOf("/") + 1)))
            .map((l) => l.key.slice(l.key.indexOf("/") + 1)),
        );
        readings.prices.push({
          assets: pricesProbe.request.assets,
          currency: pricesProbe.request.currency,
          status: res.status,
          providers: (res.headers.get("x-gateway-providers") ?? "")
            .split(",")
            .filter((p) => p !== ""),
          cached: cached.size,
          upstream,
        });
      }
      return res;
    } finally {
      inflight -= 1;
    }
  };

  const engine = createWalletEngine({
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet: opts.wallet,
    sparkNetwork: "regtest",
    fetch: engineFetch,
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: () => undefined },
    showCallsStatus: () => undefined,
    // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
    openStore: async () => createMemoryEngineStore(),
    rpc: opts.rpc ?? {
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": [HOST_SOLANA_URL],
      "tron:728126428": [HOST_TRON_URL],
    },
    gateway: { url: GATEWAY_URL },
  });
  for (let i = 0; i < 300; i += 1) {
    if (engine.accounts.getState().status === "ready") {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential polling
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  const shareSums = (): Map<string, number> => {
    const perKey = new Map<string, number>();
    for (const { key, delta } of shareCalls) {
      perKey.set(key, (perKey.get(key) ?? 0) + delta);
    }
    return perKey;
  };
  const upstreamUnits = new Map<string, { calls: number; units: number }>();
  return {
    engine,
    // oxlint-disable-next-line no-non-null-assertion -- the harness wallet always has one wallet
    walletId: opts.wallet.getSnapshot().wallets[0]!.walletId,
    stub,
    host,
    readings: {
      ...readings,
      share: shareSums(),
      upstream: upstreamUnits,
      budget: new Map(),
      host: new Map(),
      prices: [],
      limiterTakes,
      takes: budgetTakes,
      clientScopes,
    },
    inflight: () => inflight,
    advance: (ms: number) => {
      nowMs += ms;
    },
    clock: () => nowMs,
    pressureTron: async (n: number): Promise<void> => {
      const headers = new Headers({
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.7",
        [CLIENT_ID_HEADER]: "00000000000000000000000000000001",
      });
      for (let i = 0; i < n; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential pressure, each take recorded
        const res = await app.request("/v1/tron/tron:728126428/wallet/getnowblock", {
          method: "POST",
          headers,
          body: "{}",
        });
        if (res.status !== 200) {
          return; // already refused — the shared budget is where the pressure needs it
        }
      }
    },
    clientScopes,
    snapshot: () => {
      // Recompute attribution so far: budget takes by account, upstream calls by account, share
      // sums per key. Routes/statuses stream into `readings` continuously.
      const upstream = new Map<string, { calls: number; units: number }>();
      for (const { account } of stub.calls) {
        const e = upstream.get(account) ?? { calls: 0, units: 0 };
        upstream.set(account, { calls: e.calls + 1, units: e.units });
      }
      for (const { account, units } of budgetTakes) {
        const e = upstream.get(account) ?? { calls: 0, units: 0 };
        upstream.set(account, { calls: e.calls, units: e.units + units });
      }
      const hostCalls = new Map<string, number>();
      for (const { account } of host.calls) {
        hostCalls.set(account, (hostCalls.get(account) ?? 0) + 1);
      }
      return {
        routes: deepCopy(readings.routes),
        statuses: deepCopy(readings.statuses),
        routeStatuses: deepCopy(readings.routeStatuses),
        routePaths: deepCopy(readings.routePaths),
        prices: [...readings.prices],
        upstream,
        pinned: deepCopy(readings.pinned),
        host: hostCalls,
        budget: (() => {
          const m = new Map<string, number>();
          for (const t of budgetTakes) {
            m.set(t.account, (m.get(t.account) ?? 0) + t.units);
          }
          return m;
        })(),
        share: shareSums(),
        limiterTakes: [...limiterTakes],
        takes: [...budgetTakes],
        clientScopes: new Map(clientScopes),
      };
    },
  };
};

/** Waits until no gateway request has been in flight for `quietMs`. */
export const quietFor = async (world: World, quietMs = 500): Promise<void> => {
  let quiet = 0;
  while (quiet < quietMs) {
    // oxlint-disable-next-line no-await-in-loop -- sequential polling
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    quiet = world.inflight() === 0 ? quiet + 50 : 0;
  }
};

/** The wallet's per-family first addresses (HD group 0), derived through the kernel. */
export const walletAddresses = async (
  wallet: Awaited<ReturnType<typeof createNodeWallet>>,
  walletId: string,
  networks: ReadonlyArray<{ id: string }>,
): Promise<{ evm: string; solana: string; tron: string; xpubs: Record<string, string> }> => {
  const api = chains(wallet);
  const evm = strField(
    await api.account({ walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" }),
    "address",
  );
  const sol = strField(
    await api.account({
      walletId,
      groupIndex: 0,
      template: "solana.bip44-change",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    }),
    "address",
  );
  const tron = strField(
    await api.account({
      walletId,
      groupIndex: 0,
      template: "tron.bip44",
      network: "tron:728126428",
    }),
    "address",
  );
  const xpubs: Record<string, string> = {};
  if (networks.some((n) => n.id.startsWith("bip122:"))) {
    for (const template of ["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- sequential kernel account derivation
      const acct = await api.account({
        walletId,
        groupIndex: 0,
        template,
        network: "bip122:000000000019d6689c085ae165831e93",
      });
      const xpub = strField(acct, "xpub");
      if (xpub !== "") {
        xpubs[template] = xpub;
      }
    }
  }
  return { evm, solana: sol, tron, xpubs };
};

export { approval } from "../approval.ts";
export type { Account } from "../../../../apps/gateway/src/config/accounts.ts";
