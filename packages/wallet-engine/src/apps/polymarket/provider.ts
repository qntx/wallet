/**
 * The Polymarket provider facade — unauthenticated market reads today; L2 trading, enablement,
 * funding and live views land in later layers on the same injected-I/O surface.
 */
import type { SetTimer } from "../../timer.ts";
import { createPolymarketHttp } from "./http.ts";
import { createPolymarketMarkets } from "./markets.ts";
import type { PolymarketMarkets } from "./markets.ts";

/** The four `POLY_BUILDER_*` headers the host's builder signer returns (research.md §2/§9). */
export type PolymarketBuilderHeaders = {
  readonly POLY_BUILDER_API_KEY: string;
  readonly POLY_BUILDER_PASSPHRASE: string;
  readonly POLY_BUILDER_SIGNATURE: string;
  readonly POLY_BUILDER_TIMESTAMP: string;
};

/**
 * The host-injected Remote Builder Signing surface (invariant 9): the host's server holds the
 * builder secret and HMACs `{method, path, body}` relayer submissions; `code` is the bytes32
 * builder code attached to orders, absent means the zero code.
 */
export type PolymarketBuilder = {
  readonly code?: `0x${string}`;
  readonly sign: (request: {
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }) => Promise<PolymarketBuilderHeaders>;
};

export type PolymarketProviderOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly timeoutMs?: number;
  /** Stored for the enable/relayer layers — validated by `createApps`. */
  readonly builder?: PolymarketBuilder;
};

export type PolymarketProvider = {
  readonly markets: PolymarketMarkets;
  /** The configured builder, when the host supplied one — nothing else reads it yet. */
  readonly builder?: PolymarketBuilder;
};

export function createPolymarketProvider(options: PolymarketProviderOptions): PolymarketProvider {
  const http = createPolymarketHttp({
    fetch: options.fetch,
    setTimer: options.setTimer,
    now: options.now,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    markets: createPolymarketMarkets(http),
    ...(options.builder === undefined ? {} : { builder: options.builder }),
  };
}
