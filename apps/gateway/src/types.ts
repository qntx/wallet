import type { CostModel } from "./budget/costs.ts";
import type { Account } from "./config/accounts.ts";
import type { RiskStore } from "./risk/phishing.ts";
import type { TokenListStore } from "./tokens/build.ts";

export type RateLimiter = {
  limit: (options: { key: string; delta?: number }) => Promise<{ success: boolean }>;
};

export type Limiters = {
  /** Per IP prefix across every client id — the ceiling rotating client ids cannot escape. */
  readonly ip: RateLimiter;
  readonly rpc: RateLimiter;
  readonly default: RateLimiter;
  /**
   * Shares of each provider account's per-minute budget, keyed `account:ip-prefix`: one client's
   * traffic is bounded in the provider's own units even when its calls are cheap per request.
   */
  readonly share: RateLimiter;
};

/** The provider account an upstream authenticates against, by name — never a secret. */
export type UpstreamAuthId = "alchemy" | "drpc" | "blockstream";

/** One upstream endpoint for a network: a JSON-RPC URL (EVM, Solana) or an Esplora base URL. */
export type UpstreamProvider = {
  readonly id: string;
  readonly url: string;
  /** Which provider account authenticates requests to this endpoint. */
  readonly auth?: UpstreamAuthId;
};

/** Request headers authenticating one provider account, resolved per request. */
export type UpstreamAuth = () => Promise<Readonly<Record<string, string>>>;

/** A provider whose auth name and billing account were resolved at construction. */
export type ResolvedProvider = Omit<UpstreamProvider, "auth"> & {
  readonly auth?: UpstreamAuth;
  /** The provider account this provider's calls are metered against — `auth ?? id`. */
  readonly account: string;
  /** How `account` prices this provider's calls. */
  readonly costs: CostModel;
};

/** A served network: a registry CAIP-2 id and its upstreams in priority order. */
export type GatewayNetwork = {
  readonly id: string;
  readonly providers: ReadonlyArray<UpstreamProvider>;
};

/** The verdict of one account-budget draw: granted, or refused with a wait hint. */
export type BudgetDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number };

/**
 * The gateway-wide per-account budget — the counter every isolate shares, so the provider sees at
 * most the account's configured quota worldwide. A refused `take` means the shared quota is spent:
 * the caller must not reach the provider.
 */
export type ProviderBudget = {
  readonly take: (account: string, units: number) => Promise<BudgetDecision>;
};

/**
 * Per-asset price cache shared by every client: keys never carry client identity. `get` answers
 * `undefined` on a miss; entries live at most `ttlSeconds` (the reader also checks the embedded
 * expiry, so a store that keeps entries longer cannot serve them stale).
 */
export type PriceCache = {
  readonly get: (key: string) => Promise<string | undefined>;
  readonly put: (key: string, value: string, ttlSeconds: number) => Promise<void>;
};

export type GatewayOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly networks: ReadonlyArray<GatewayNetwork>;
  readonly limiters: Limiters;
  readonly corsOrigins: ReadonlyArray<string>;
  readonly risk: RiskStore;
  /** Published token lists the scheduled build writes and `GET /v1/tokens` serves. */
  readonly tokens: TokenListStore;
  /**
   * Provider accounts by auth name. A configured provider naming an `auth` absent here fails
   * construction — a keyed endpoint is never called unauthenticated.
   */
  readonly auth: Readonly<Partial<Record<UpstreamAuthId, UpstreamAuth>>>;
  /**
   * Provider accounts by name (`auth ?? id`): cost model and budget for every upstream the gateway
   * can call. A configured provider without an account fails construction.
   */
  readonly accounts: Readonly<Record<string, Account>>;
  /**
   * The shared per-account budget every upstream call draws after the client's share. Backed by the
   * `PROVIDER_BUDGET` Durable Object in production, by an in-isolate implementation in tests.
   */
  readonly budget: ProviderBudget;
  /**
   * The 0x API key that enables `/v1/quotes/swap`, and the integrator fee the gateway charges on
   * top of a quote, when configured. Absent the route answers `unavailable`.
   */
  readonly zeroEx?: {
    readonly apiKey: string;
    readonly fee?: { readonly recipient: string; readonly bps: number };
  };
  /** A Jupiter API key for `/v1/quotes/swap/solana` — absent, the upstream is called keyless. */
  readonly jupiter?: { readonly apiKey: string };
  /**
   * Spot prices: the shared per-asset cache, and the CoinGecko Pro key that enables the primary
   * source. Without the key only the keyless DefiLlama fallback serves, and it quotes USD only.
   */
  readonly prices: {
    readonly cache: PriceCache;
    readonly coingecko?: { readonly apiKey: string };
  };
  /** The wall clock, Unix ms; defaults to `Date.now`. */
  readonly now?: () => number;
  /** One JSON line per request; defaults to `console.log`. */
  readonly log?: (line: string) => void;
};
