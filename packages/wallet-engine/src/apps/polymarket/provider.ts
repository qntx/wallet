/**
 * The Polymarket provider facade — unauthenticated market reads, account reads scoped to the
 * located wallet, L2-authenticated reads HMAC'd in the engine over the group's stored
 * credentials, order placement through a kernel-described `TypedDataSign` approval, live
 * book/account views over the injected socket, and pUSD funding through the request pipeline and
 * the builder-signed relayer.
 */
import type { Wallet } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";

import type { EngineLogger } from "../../events.ts";
import type { AppAvailability } from "../../gateway/contract/eligibility.ts";
import type { RequestController } from "../../requests/controller.ts";
import type { SetTimer } from "../../timer.ts";
import type { AppSocket } from "../socket.ts";
import type { AppGroup } from "../types.ts";
import { createPolymarketAccount } from "./account.ts";
import type { PolymarketAccountReads } from "./account.ts";
import type { PolymarketCredentialStore } from "./credentials.ts";
import { PolymarketError } from "./errors.ts";
import { createPolymarketFunding } from "./funding.ts";
import type { PolymarketFunding } from "./funding.ts";
import { createPolymarketHttp } from "./http.ts";
import { createPolymarketL2 } from "./l2.ts";
import { createPolymarketLive } from "./live.ts";
import type { PolymarketLive } from "./live.ts";
import { createPolymarketMarkets } from "./markets.ts";
import type { PolymarketMarkets } from "./markets.ts";
import { createPolymarketRelayer } from "./relayer.ts";
import type { PolymarketBuilderHeaders } from "./relayer.ts";
import { createPolymarketTrade } from "./trade.ts";
import type { PolymarketTrading } from "./trade.ts";
import { createPolymarketWallets } from "./wallets.ts";

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
  /** The wallet the kernel signs orders for — `chains(wallet)` derives each group's signer. */
  readonly wallet: Wallet;
  /** The group's stored CLOB credentials — built from `context.storage` by the app definition. */
  readonly credentials: PolymarketCredentialStore;
  /** The approval pipeline orders are signed through. */
  readonly requests: Pick<RequestController, "prepare" | "outcome">;
  /** Order salts come from this — 8 bytes → 53-bit. */
  readonly random: (length: number) => Uint8Array;
  /** The gateway availability for `polymarket` — `undefined` refuses BUY orders (fail closed). */
  readonly availability: () => AppAvailability | undefined;
  /** The WebSocket factory live views stream over — `(url) => new WebSocket(url)`. */
  readonly socket: (url: string) => AppSocket;
  readonly logger: EngineLogger;
  /** The host's Remote Builder Signing oracle for relayer submits — validated by `createApps`. */
  readonly builder?: PolymarketBuilder;
};

export type PolymarketProvider = {
  readonly markets: PolymarketMarkets;
  readonly account: PolymarketAccountReads;
  readonly trade: PolymarketTrading;
  readonly live: PolymarketLive;
  readonly fund: PolymarketFunding;
};

const isEvmAddress = (address: string): address is `0x${string}` =>
  /^0x[0-9a-fA-F]{40}$/.test(address);

export type { PolymarketBuilderHeaders } from "./relayer.ts";

export function createPolymarketProvider(options: PolymarketProviderOptions): PolymarketProvider {
  const http = createPolymarketHttp({
    fetch: options.fetch,
    setTimer: options.setTimer,
    now: options.now,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const signerOf = async (group: AppGroup): Promise<`0x${string}`> => {
    /* The signature chain names the group account: Polygon. */
    let resolved;
    try {
      resolved = await chains(options.wallet).account({
        walletId: group.walletId,
        groupIndex: group.groupIndex,
        template: "evm.bip44",
        network: "eip155:137",
      });
    } catch (error) {
      /* A lock landing between the store read and this derivation is the same gate — the
         session close is event-ordered, so a kernel `locked` still maps to unlock-required. */
      if (error instanceof WalletError && error.code === "locked") {
        throw new PolymarketError("unlock-required", "the vault is locked", { cause: error });
      }
      throw error;
    }
    if (!("address" in resolved) || !isEvmAddress(resolved.address)) {
      throw new PolymarketError("unavailable", "the group has no EVM address");
    }
    return resolved.address;
  };
  const l2 = createPolymarketL2({
    http,
    credentials: options.credentials,
    signerOf,
    now: options.now,
  });
  const account = createPolymarketAccount({
    http,
    l2,
    wallets: createPolymarketWallets(http),
    signerOf,
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
  const relayer = createPolymarketRelayer({
    http,
    setTimer: options.setTimer,
    now: options.now,
    ...(options.builder === undefined ? {} : { builder: options.builder }),
  });
  const live = createPolymarketLive({
    account,
    socket: options.socket,
    setTimer: options.setTimer,
    now: options.now,
    random: options.random,
    wallet: options.wallet,
    logger: options.logger,
  });
  const fund = createPolymarketFunding({
    account,
    relayer,
    requests: options.requests,
    hasBuilder: options.builder !== undefined,
    now: options.now,
    setTimer: options.setTimer,
  });
  return {
    markets,
    account,
    trade,
    live,
    fund,
  };
}
