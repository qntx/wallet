import type { RiskStore } from "./risk/phishing.ts";

export type RateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
};

export type Limiters = {
  readonly rpc: RateLimiter;
  readonly default: RateLimiter;
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

/** A provider whose auth name has been resolved to its header function at construction. */
export type ResolvedProvider = Omit<UpstreamProvider, "auth"> & {
  readonly auth?: UpstreamAuth;
};

/** A served network: a registry CAIP-2 id and its upstreams in priority order. */
export type GatewayNetwork = {
  readonly id: string;
  readonly providers: ReadonlyArray<UpstreamProvider>;
};

export type GatewayOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly networks: ReadonlyArray<GatewayNetwork>;
  readonly limiters: Limiters;
  readonly corsOrigins: ReadonlyArray<string>;
  readonly risk: RiskStore;
  /**
   * Provider accounts by auth name. A configured provider naming an `auth` absent here fails
   * construction — a keyed endpoint is never called unauthenticated.
   */
  readonly auth: Readonly<Partial<Record<UpstreamAuthId, UpstreamAuth>>>;
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
  /** One JSON line per request; defaults to `console.log`. */
  readonly log?: (line: string) => void;
};
