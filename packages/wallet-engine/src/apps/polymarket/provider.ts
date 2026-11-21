import type { Wallet } from "@qntx/wallet";
/**
 * The Polymarket provider facade — unauthenticated market reads, account reads scoped to the
 * located wallet, L2-authenticated reads signed inside the kernel, and order placement through a
 * kernel-described `TypedDataSign` approval. Enablement, funding and live views land in later
 * layers on the same injected-I/O surface.
 */
import { chains } from "@qntx/wallet/chains";

import type { AppAvailability } from "../../gateway/contract/eligibility.ts";
import type { RequestController } from "../../requests/controller.ts";
import type { SetTimer } from "../../timer.ts";
import type { AppGroup } from "../types.ts";
import { createPolymarketAccount } from "./account.ts";
import type { PolymarketAccountReads } from "./account.ts";
import { PolymarketError } from "./errors.ts";
import { createPolymarketHttp } from "./http.ts";
import { createPolymarketL2 } from "./l2.ts";
import { createPolymarketMarkets } from "./markets.ts";
import type { PolymarketMarkets } from "./markets.ts";
import { createPolymarketTrade } from "./trade.ts";
import type { PolymarketTrading } from "./trade.ts";
import { createPolymarketWallets } from "./wallets.ts";

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
  /** The wallet the kernel signs L2 requests for — `polymarket(wallet)` and `chains(wallet)`. */
  readonly wallet: Wallet;
  /** The approval pipeline orders are signed through. */
  readonly requests: Pick<RequestController, "prepare" | "outcome">;
  /** Order salts come from this — 8 bytes → 53-bit. */
  readonly random: (length: number) => Uint8Array;
  /** The gateway availability for `polymarket` — `undefined` refuses BUY orders (fail closed). */
  readonly availability: () => AppAvailability | undefined;
  /** Stored for the enable/relayer layers — validated by `createApps`. */
  readonly builder?: PolymarketBuilder;
};

export type PolymarketProvider = {
  readonly markets: PolymarketMarkets;
  readonly account: PolymarketAccountReads;
  readonly trade: PolymarketTrading;
  /** The configured builder, when the host supplied one — nothing else reads it yet. */
  readonly builder?: PolymarketBuilder;
};

const isEvmAddress = (address: string): address is `0x${string}` =>
  /^0x[0-9a-fA-F]{40}$/.test(address);

export function createPolymarketProvider(options: PolymarketProviderOptions): PolymarketProvider {
  const http = createPolymarketHttp({
    fetch: options.fetch,
    setTimer: options.setTimer,
    now: options.now,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  /* Deferred so a provider built for reads only does not need a live wallet object — the first
     L2 or locate call resolves it (the Hyperliquid provider defers the same way). */
  const l2 = createPolymarketL2({ wallet: options.wallet, http, now: options.now });
  const account = createPolymarketAccount({
    http,
    l2,
    wallets: createPolymarketWallets(http),
    signerOf: async (group: AppGroup) => {
      /* The signature chain names the group account: Polygon. */
      const resolved = await chains(options.wallet).account({
        walletId: group.walletId,
        groupIndex: group.groupIndex,
        template: "evm.bip44",
        network: "eip155:137",
      });
      if (!("address" in resolved) || !isEvmAddress(resolved.address)) {
        throw new PolymarketError("unavailable", "the group has no EVM address");
      }
      return resolved.address;
    },
  });
  const markets = createPolymarketMarkets(http);
  const trade = createPolymarketTrade({
    l2,
    account,
    markets,
    requests: options.requests,
    random: options.random,
    now: options.now,
    setTimer: options.setTimer,
    availability: options.availability,
    ...(options.builder === undefined ? {} : { builder: options.builder }),
  });
  return {
    markets,
    account,
    trade,
    ...(options.builder === undefined ? {} : { builder: options.builder }),
  };
}
