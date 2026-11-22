/**
 * Workerd harness worker: the REAL gateway (createGateway) over the REAL ProviderBudgetObject
 * Durable Object and REAL rate-limit bindings, with every upstream pointed at an in-worker stub —
 * no real provider is ever contacted.
 *
 * Two extra controls:
 *
 * - `x-test-ip` is copied into `cf-connecting-ip` (local workerd overwrites it); the literal `none`
 *   deletes it, which the required client address rejects.
 * - `SCALE=small` swaps PRODUCTION_ACCOUNTS for tiny buckets so exhaustion is fast.
 * - `UPSTREAM_DELAY_MS` adds a fixed delay inside the stub upstream. Driver bypass routes: `GET
 *   /__stats`, `POST /__reset`.
 */
import { createGateway } from "../../src/app.ts";
import { ALCHEMY_COSTS, rpcCost } from "../../src/budget/costs.ts";
import type { ProviderBudgetObject } from "../../src/budget/durable.ts";
import type { BudgetNamespace } from "../../src/budget/leased.ts";
import { durableBudget } from "../../src/budget/leased.ts";
import type { Account } from "../../src/config/accounts.ts";
import { PRODUCTION_ACCOUNTS } from "../../src/config/accounts.ts";
import { PRODUCTION_NETWORKS } from "../../src/config/networks.ts";
import type { UpstreamAuthId } from "../../src/types.ts";
import { upstreamAnswer } from "../upstream-stub.ts";

export { ProviderBudgetObject } from "../../src/budget/durable.ts";

type HarnessEnv = {
  readonly PROVIDER_BUDGET: DurableObjectNamespace<ProviderBudgetObject>;
  readonly IP_LIMITER: RateLimit;
  readonly RPC_LIMITER: RateLimit;
  readonly DEFAULT_LIMITER: RateLimit;
  readonly SHARE_LIMITER: RateLimit;
  readonly SCALE?: string;
  readonly UPSTREAM_DELAY_MS?: string;
};

type LeaseStats = { calls: number; granted: number; refused: number };
const leaseStats = new Map<string, LeaseStats>();
type UpstreamStats = { calls: number; units: number };
const upstreamStats = new Map<string, UpstreamStats>();

const leaseStat = (account: string): LeaseStats => {
  const existing = leaseStats.get(account);
  if (existing !== undefined) {
    return existing;
  }
  const created: LeaseStats = { calls: 0, granted: 0, refused: 0 };
  leaseStats.set(account, created);
  return created;
};
const upstreamStat = (account: string): UpstreamStats => {
  const existing = upstreamStats.get(account);
  if (existing !== undefined) {
    return existing;
  }
  const created: UpstreamStats = { calls: 0, units: 0 };
  upstreamStats.set(account, created);
  return created;
};

const resetStats = (): void => {
  leaseStats.clear();
  upstreamStats.clear();
};

/** Wraps the real DO namespace, counting lease RPCs, granted units and refusals per account. */
const countingNamespace = (
  namespace: DurableObjectNamespace<ProviderBudgetObject>,
): BudgetNamespace => {
  const names = new Map<string, string>(); // object id hex → account
  return {
    idFromName: (name) => {
      const id = namespace.idFromName(name);
      names.set(id.toString(), name);
      return id;
    },
    get: (id) => {
      let stub: ReturnType<typeof namespace.get>;
      try {
        stub = namespace.get(id);
      } catch (error) {
        console.log(JSON.stringify({ event: "harness-get-threw", error: String(error) }));
        throw error;
      }
      const account = names.get(id.toString()) ?? "unknown";
      return {
        lease: async (windows, want, min) => {
          const stat = leaseStat(account);
          stat.calls += 1;
          try {
            const result = await stub.lease(windows, want, min);
            if (result.ok) {
              stat.granted += result.granted;
            } else {
              stat.refused += 1;
            }
            return result;
          } catch (error) {
            console.log(
              JSON.stringify({ event: "harness-lease-threw", account, error: String(error) }),
            );
            throw error;
          }
        },
      };
    },
  };
};

const json = (body: unknown): Response => Response.json(body);

type Gateway = ReturnType<typeof createGateway>;

type RpcCalls = { method: string } | ReadonlyArray<{ method: string }>;
const isCalls = (value: unknown): value is RpcCalls =>
  Array.isArray(value) || (typeof value === "object" && value !== null && "method" in value);

const oneReply = (call: unknown): unknown => ({
  jsonrpc: "2.0",
  id: typeof call === "object" && call !== null && "id" in call ? call.id : null,
  result: "0x1",
});

/** JSON-RPC POST → `{"jsonrpc":"2.0","id":<same>,"result":"0x1"}` (batch → array). */
const rpcReply = (parsed: unknown): Response =>
  json(Array.isArray(parsed) ? parsed.map(oneReply) : oneReply(parsed));

const TRON_BLOCK = {
  blockID: "a".repeat(64),
  block_header: { raw_data: { number: 1, timestamp: 1 } },
};

/** Upstream host → billing account (mirrors PRODUCTION_NETWORKS + code-built providers). */
const accountOf = (host: string): string | undefined => {
  if (host.endsWith("g.alchemy.com")) {
    return "alchemy";
  }
  switch (host) {
    case "lb.drpc.live":
      return "drpc";
    case "rpc.ankr.com":
      return "ankr";
    case "api.trongrid.io":
      return "trongrid";
    case "tron-mainnet.gateway.tatum.io":
      return "tatum";
    case "enterprise.blockstream.info":
      return "blockstream";
    case "pro-api.coingecko.com":
      return "coingecko";
    case "coins.llama.fi":
      return "defillama";
    case "api.jup.ag":
      return "jupiter";
    case "app.across.to":
      return "across";
    case "api.0x.org":
      return "0x";
    default:
      return undefined;
  }
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
};

const upstream = (delayMs: number): typeof globalThis.fetch => {
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const host = url.hostname;
    const account = accountOf(host);
    if (account === undefined) {
      throw new TypeError(`harness stub: no upstream for ${raw}`);
    }
    const body = typeof init?.body === "string" ? init.body : "";
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    // JSON-RPC providers: the stub computes the same per-call cost the route billed.
    if (account === "alchemy" || account === "drpc" || account === "ankr") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      const calls = isCalls(parsed) ? parsed : undefined;
      const units =
        calls === undefined
          ? 0
          : account === "alchemy"
            ? rpcCost(ALCHEMY_COSTS, calls)
            : Array.isArray(calls)
              ? calls.length
              : 1;
      const stat = upstreamStat(account);
      stat.calls += 1;
      stat.units += units;
      // Single calls go through the shared smoke stub (a real chain id, the genesis hash, a
      // defined result for everything else); batches keep the generic echo reply.
      return calls !== undefined && !Array.isArray(calls)
        ? upstreamAnswer({ url: raw, body })
        : rpcReply(parsed);
    }

    const stat = upstreamStat(account);
    stat.calls += 1;
    stat.units += 1;

    if (account === "trongrid" || account === "tatum") {
      if (url.pathname.startsWith("/v1/accounts/")) {
        return json({ success: true, data: [], meta: {} });
      }
      if (url.pathname.endsWith("/getnowblock")) {
        return json(TRON_BLOCK);
      }
      // /wallet/getchainparameters and every other proxied path — the smoke stub answers them.
      return upstreamAnswer({ url: raw, body });
    }
    if (account === "jupiter") {
      return json({
        inputMint: url.searchParams.get("inputMint"),
        outputMint: url.searchParams.get("outputMint"),
        inAmount: url.searchParams.get("amount"),
        outAmount: "999000",
        otherAmountThreshold: "990000",
        slippageBps: Number(url.searchParams.get("slippageBps") ?? "50"),
        swapInstruction: {
          programId: "11111111111111111111111111111111",
          accounts: [],
          data: "",
        },
        transactionVersion: 0,
      });
    }
    // across / 0x are not network providers — the shared stub has no answer for them.
    if (account === "across" || account === "0x") {
      return json({});
    }
    // blockstream (genesis hash text) and the price providers — the smoke stub answers them.
    return upstreamAnswer({ url: raw, body });
  };
  return fetchStub;
};

/** `SCALE=small`: production cost models, tiny windows so exhaustion happens in seconds. */
const scaledAccounts = (): Readonly<Record<string, Account>> =>
  Object.fromEntries(
    Object.entries(PRODUCTION_ACCOUNTS).map(([id, account]) => [
      id,
      {
        ...account,
        budget: [{ units: id === "alchemy" ? 400 : 10, seconds: 5 }],
      },
    ]),
  );

const AUTH_IDS: ReadonlyArray<UpstreamAuthId> = [
  "alchemy",
  "drpc",
  "blockstream",
  "ankr",
  "trongrid",
  "tatum",
];

let gateway: Gateway | undefined;

const gatewayFor = (env: HarnessEnv): Gateway => {
  if (gateway === undefined) {
    const accounts = env.SCALE === "small" ? scaledAccounts() : PRODUCTION_ACCOUNTS;
    const priceCache = new Map<string, { value: string; expiresAt: number }>();
    gateway = createGateway({
      fetch: upstream(Number(env.UPSTREAM_DELAY_MS ?? "0")),
      networks: PRODUCTION_NETWORKS,
      limiters: {
        ip: env.IP_LIMITER,
        rpc: env.RPC_LIMITER,
        default: env.DEFAULT_LIMITER,
        share: env.SHARE_LIMITER,
      },
      corsOrigins: [],
      risk: {
        get: async () => {
          await Promise.resolve();
          return undefined;
        },
        put: async () => {
          await Promise.resolve();
        },
      },
      tokens: {
        get: async () => {
          await Promise.resolve();
          return undefined;
        },
        put: async () => {
          await Promise.resolve();
        },
      },
      tokenNetworks: new Set(PRODUCTION_NETWORKS.map((network) => network.id)),
      auth: Object.fromEntries(
        AUTH_IDS.map((id) => [
          id,
          async () => {
            await Promise.resolve();
            return {};
          },
        ]),
      ),
      accounts,
      budget: durableBudget(
        countingNamespace(env.PROVIDER_BUDGET),
        accounts,
        () => Date.now(),
        (line) => {
          console.log(line);
        },
      ),
      prices: {
        cache: {
          get: async (key) => {
            const entry = priceCache.get(key);
            await Promise.resolve();
            return entry !== undefined && entry.expiresAt > Date.now() ? entry.value : undefined;
          },
          put: async (key, value, ttlSeconds) => {
            priceCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
            await Promise.resolve();
          },
        },
        // Enables the CoinGecko source so the eur/413 share math runs; the key is fake.
        coingecko: { apiKey: "harness-stub" },
      },
      jupiter: { apiKey: "harness-stub" },
      clientAddress: "required",
      log: (line) => {
        console.log(line);
      },
    });
  }
  return gateway;
};

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") {
      return json({
        leases: Object.fromEntries(leaseStats),
        upstream: Object.fromEntries(upstreamStats),
      });
    }
    if (url.pathname === "/__reset") {
      resetStats();
      return new Response("ok");
    }
    // Local workerd decides cf-connecting-ip itself; let the driver override it.
    const headers = new Headers(request.headers);
    const testIp = headers.get("x-test-ip");
    headers.delete("x-test-ip");
    if (testIp === null || testIp === "none") {
      headers.delete("cf-connecting-ip");
    } else {
      headers.set("cf-connecting-ip", testIp);
    }
    const forwarded = new Request(request, { headers });
    return gatewayFor(env).fetch(forwarded);
  },
} satisfies ExportedHandler<HarnessEnv>;
