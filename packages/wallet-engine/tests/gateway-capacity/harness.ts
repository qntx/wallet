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
import { buildTokenLists } from "../../../../apps/gateway/src/tokens/build.ts";
import type { TokenListStore } from "../../../../apps/gateway/src/tokens/build.ts";
import { tokenListSources } from "../../../../apps/gateway/src/tokens/sources.ts";
import type { Limiters, RateLimiter } from "../../../../apps/gateway/src/types.ts";
import { createWalletEngine } from "../../src/engine.ts";
import type { WalletEngine } from "../../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../../src/store/memory.ts";
import type { Stub, WalletModel } from "./upstream.ts";
import { stubUpstream, tokenListFetch } from "./upstream.ts";

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
  if (pathname === "/v1/prices") {
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

export type Readings = {
  readonly routes: Map<string, number>;
  readonly statuses: Map<number, number>;
  readonly upstream: Map<string, { calls: number; units: number }>;
  readonly budget: Map<string, number>;
  readonly share: Map<string, number>;
};

export const emptyReadings = (): Readings => ({
  routes: new Map(),
  statuses: new Map(),
  upstream: new Map(),
  budget: new Map(),
  share: new Map(),
});

export type World = {
  readonly engine: WalletEngine;
  readonly walletId: string;
  readonly stub: Stub;
  readonly readings: Readings;
  /** In-flight gateway requests — cold-start waits for 500 ms of quiet. */
  readonly inflight: () => number;
  readonly snapshot: () => Readings;
};

const deepCopy = <K, T>(m: ReadonlyMap<K, T>): Map<K, T> => new Map(m);

export const snapshotOf = (r: Readings): Readings => ({
  routes: deepCopy(r.routes),
  statuses: deepCopy(r.statuses),
  upstream: new Map([...r.upstream].map(([k, v]) => [k, { ...v }])),
  budget: deepCopy(r.budget),
  share: deepCopy(r.share),
});

export const diffReadings = (after: Readings, before: Readings): Readings => ({
  routes: new Map([...after.routes].map(([k, v]) => [k, v - (before.routes.get(k) ?? 0)] as const)),
  statuses: new Map(
    [...after.statuses].map(([k, v]) => [k, v - (before.statuses.get(k) ?? 0)] as const),
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
}): Promise<World> => {
  const networks = opts.networks ?? PRODUCTION_NETWORKS;
  // The limiter/budget clock is fake: a refusal advances it by the announced wait instead of
  // real time, so a burst that hits a production window becomes instant virtual minutes, not a
  // 20-minute test. Refused calls are still recorded in statuses — the table shows them.
  let nowMs = Date.now();
  const now = () => nowMs;
  const limits = productionLimits();
  const stub = stubUpstream(opts.model, providerPrefixes(networks), opts.tronAddress ?? "");

  const shareCalls: Array<{ key: string; delta: number }> = [];
  const shareInner = windowedCountBefore(limits["SHARE_LIMITER"]?.limit ?? 1000, 60_000, now);
  const share: RateLimiter = {
    limit: async ({ key, delta = 1 }) => {
      shareCalls.push({ key, delta });
      return shareInner.limit({ key, delta });
    },
  };
  const limiters: Limiters = {
    ip: windowedCountBefore(limits["IP_LIMITER"]?.limit ?? 300, 10_000, now),
    rpc: windowedCountBefore(limits["RPC_LIMITER"]?.limit ?? 100, 10_000, now),
    default: windowedCountBefore(limits["DEFAULT_LIMITER"]?.limit ?? 50, 10_000, now),
    share,
  };

  const budgetTakes: Array<{ account: string; units: number }> = [];
  const budgetInner = localBudget(PRODUCTION_ACCOUNTS, now);
  const budget = {
    take: async (account: string, units: number) => {
      budgetTakes.push({ account, units });
      return budgetInner.take(account, units);
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
    prices: { cache: risk, coingecko: { apiKey: "stub" } },
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
  let inflight = 0;
  const engineFetch: typeof globalThis.fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target);
    if (url.origin !== GATEWAY_URL) {
      return stub.fetch(input, init);
    }
    const path = url.pathname;
    readings.routes.set(routeClass(path), (readings.routes.get(routeClass(path)) ?? 0) + 1);
    inflight += 1;
    try {
      const headers = new Headers(init?.headers);
      headers.set("cf-connecting-ip", CLIENT_IP);
      const reqInit: { method: string; headers: Headers; body?: ArrayBuffer | string } = {
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers,
      };
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
      let res = await app.request(`${path}${url.search}`, reqInit);
      readings.statuses.set(res.status, (readings.statuses.get(res.status) ?? 0) + 1);
      // 429 (share/limiter refusal) and 503 (budget-window exhaustion on a single-provider
      // network) are both window waits: advance the limiter clock by the announced wait (or one
      // share window) and ask again. A deterministic refusal (413 too-costly, 4xx) is returned
      // as-is — retrying it would spin forever.
      for (let retry = 0; retry < 60 && (res.status === 429 || res.status === 503); retry += 1) {
        const announced = Number(res.headers.get("retry-after") ?? "60");
        nowMs += Math.max(1, announced) * 1000;
        // oxlint-disable-next-line no-await-in-loop -- bounded sequential retry
        res = await app.request(`${path}${url.search}`, reqInit);
        readings.statuses.set(res.status, (readings.statuses.get(res.status) ?? 0) + 1);
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
    rpc: {},
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
    readings: {
      ...readings,
      share: shareSums(),
      upstream: upstreamUnits,
      budget: new Map(),
    },
    inflight: () => inflight,
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
      return {
        routes: deepCopy(readings.routes),
        statuses: deepCopy(readings.statuses),
        upstream,
        budget: (() => {
          const m = new Map<string, number>();
          for (const t of budgetTakes) {
            m.set(t.account, (m.get(t.account) ?? 0) + t.units);
          }
          return m;
        })(),
        share: shareSums(),
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
