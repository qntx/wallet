import type { RiskStore } from "./risk/phishing.ts";

export type RateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
};

export type Limiters = {
  readonly rpc: RateLimiter;
  readonly default: RateLimiter;
};

/** One upstream endpoint for a network: a JSON-RPC URL (EVM, Solana) or an Esplora base URL. */
export type UpstreamProvider = {
  readonly id: string;
  readonly url: string;
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
