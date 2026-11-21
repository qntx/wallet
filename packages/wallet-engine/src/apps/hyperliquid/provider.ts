import type { Wallet } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { hyperliquid } from "@qntx/wallet/hyperliquid";

import type { EvmFeeTier } from "../../chains/evm.ts";
import type { EngineLogger } from "../../events.ts";
import { RequestEndedError } from "../../requests/controller.ts";
import type { RequestController } from "../../requests/controller.ts";
import { createHyperliquidAccount } from "./account.ts";
import type { HyperliquidAccount } from "./account.ts";
import { createHyperliquidActions } from "./actions.ts";
import { createHyperliquidAgentRegistry } from "./agents.ts";
import type { HyperliquidAgentRegistry, HyperliquidGroup } from "./agents.ts";
import { createHyperliquidClock } from "./clock.ts";
import type { HyperliquidClock } from "./clock.ts";
import { HyperliquidError } from "./errors.ts";
import { createHyperliquidExchange } from "./exchange.ts";
import { createHyperliquidMarkets } from "./markets.ts";
import type { HyperliquidMarkets } from "./markets.ts";
import { limitPrice, meetsMinimum, notional, roundSize, slippagePrice } from "./numbers.ts";
import type { HyperliquidMarket, OrderSide } from "./numbers.ts";
import { createHyperliquidTrade } from "./trade.ts";
import type { HyperliquidTrade } from "./trade.ts";
import { createHyperliquidTransport } from "./transport.ts";
import type { HyperliquidTransportOptions } from "./transport.ts";
import { createHyperliquidUserSigned } from "./user-signed.ts";
import type { HyperliquidPendingAction, HyperliquidUserSigned } from "./user-signed.ts";

/** What a quote preview shows the interface: the wire-ready order and its value checks. */
export type HyperliquidQuotePreview = {
  /** The rounded price that would go on the wire (for a market order, the slippage cap). */
  readonly price: string;
  /** The rounded size that would go on the wire. */
  readonly size: string;
  /** `price` × `size` exactly. */
  readonly notional: string;
  /** Whether the order clears Hyperliquid's 10-quote minimum. */
  readonly meetsMinimum: boolean;
};

/** Pure order preview helpers — no I/O, safe to call on every render. */
export type HyperliquidQuote = {
  /** Preview a limit order: price rounded the user's way (buy down, sell up). */
  readonly limit: (params: {
    readonly price: string;
    readonly size: string;
    readonly side: OrderSide;
    readonly szDecimals: number;
    readonly market: HyperliquidMarket;
  }) => HyperliquidQuotePreview;
  /** Preview a market order: the IOC cap at `slippageBps` from `reference`. */
  readonly market: (params: {
    readonly reference: string;
    readonly size: string;
    readonly side: OrderSide;
    readonly slippageBps: number;
    readonly szDecimals: number;
    readonly market: HyperliquidMarket;
  }) => HyperliquidQuotePreview;
};

export type HyperliquidProvider = {
  readonly markets: HyperliquidMarkets;
  readonly account: HyperliquidAccount;
  readonly quote: HyperliquidQuote;
  /** The skew/nonce clock the transport feeds — exposed so callers can gate signing on it. */
  readonly clock: HyperliquidClock;
  /**
   * L1 trading: every method signs the exact action it posts through `signL1` with the group's
   * enabled, owner-verified agent, and reconciles an unknown order outcome by cloid.
   */
  readonly trade: HyperliquidTrade;
  /** Funding moves on the signature chain: the Bridge2 deposit into Hyperliquid. */
  readonly fund: HyperliquidFund;
  /**
   * Move balances the user-signed way — every method opens an approval request and posts the action
   * once the signature resolves.
   */
  readonly transfer: {
    /** Perp-account USDC → spot account of the same owner. */
    readonly toSpot: (group: HyperliquidGroup, amount: string) => Promise<HyperliquidPendingAction>;
    /** Spot-account USDC → perp account of the same owner. */
    readonly toPerp: (group: HyperliquidGroup, amount: string) => Promise<HyperliquidPendingAction>;
    /** Perp-account USDC to another address (`destination` lowercased). */
    readonly usdSend: (
      group: HyperliquidGroup,
      params: { readonly destination: string; readonly amount: string },
    ) => Promise<HyperliquidPendingAction>;
    /** A spot balance to another address — `token` is the `"NAME:0x<id>"` pair id. */
    readonly spotSend: (
      group: HyperliquidGroup,
      params: {
        readonly destination: string;
        readonly token: string;
        readonly amount: string;
      },
    ) => Promise<HyperliquidPendingAction>;
    /** Withdraw USDC to the owner's Arbitrum address — the bridge fee applies at the bridge. */
    readonly withdraw: (
      group: HyperliquidGroup,
      params: { readonly destination: string; readonly amount: string },
    ) => Promise<HyperliquidPendingAction>;
  };
};

/**
 * The Bridge2 deposit: an Arbitrum USDC transfer that credits the Hyperliquid account. Below
 * `MINIMUM_USDC` the funds are not credited (docs §Bridge2 — recorded in research §Deposit path and
 * evidence/bridge2-onchain.txt). Sources:
 *
 * - Bridge2 contract — https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2
 * - USDC on Arbitrum One — https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - USDC2 on Arbitrum Sepolia — Hyperliquid testnet docs (bridge2-onchain.txt).
 */
export type HyperliquidDepositInfo = {
  /** The Bridge2 contract the deposit sends USDC to. */
  readonly bridge: string;
  /** The USDC contract the deposit spends. */
  readonly usdc: string;
  /** The signature chain, CAIP-2. */
  readonly network: string;
  /** Deposits below this many base units (USDC has 6 decimals) are lost — 5 USDC. */
  readonly minimum: bigint;
  /** Bridge deposits credit inside a minute (docs §Bridge2). */
  readonly creditSeconds: number;
};

export const HYPERLIQUID_DEPOSIT: Record<"Mainnet" | "Testnet", HyperliquidDepositInfo> = {
  Mainnet: {
    bridge: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    network: "eip155:42161",
    minimum: 5_000_000n,
    creditSeconds: 60,
  },
  Testnet: {
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
    network: "eip155:421614",
    minimum: 5_000_000n,
    creditSeconds: 60,
  },
};

export type HyperliquidFund = {
  /** The Bridge2 deposit constants for the provider's network — the UI shows `minimum`. */
  readonly depositInfo: HyperliquidDepositInfo;
  /**
   * Fund the Hyperliquid account from the group's Arbitrum USDC: a `send` request to the Bridge2
   * contract. `amount` is USDC base units (6 decimals); amounts under 5 USDC are refused.
   */
  readonly deposit: (
    group: HyperliquidGroup,
    params: { readonly amount: bigint; readonly fee: EvmFeeTier },
  ) => Promise<HyperliquidPendingAction>;
};

/**
 * Internal seams `createHyperliquidProvider` returns next to the public surface — the
 * `AppsController`'s enable flow needs them; they are deliberately off the `apps` entry's exports.
 */
export type HyperliquidProviderInternals = {
  /**
   * The kernel-agent registry `trade` uses — the controller drives `refresh`, `markEnabled`,
   * `reset`, and sees `markRejected` latch rejections from the exchange path.
   */
  readonly agents: HyperliquidAgentRegistry;
  /**
   * Owner-signed actions (approvals, transfers, withdrawals) — the request pipeline signs the typed
   * data; `{requestId, outcome}` lets the host show the approval prompt.
   */
  readonly userSigned: HyperliquidUserSigned;
};

export type HyperliquidProviderOptions = Pick<
  HyperliquidTransportOptions,
  "network" | "fetch" | "setTimer" | "now" | "timeoutMs"
> & {
  /** The wallet the kernel signs L1 actions for — `hyperliquid(wallet)` and `chains(wallet)`. */
  readonly wallet: Wallet;
  /** Randomness for cloids — the engine's injected source. */
  readonly random: (length: number) => Uint8Array;
  /** Owner mismatches and other anomalies are reported here, never secrets. */
  readonly logger: EngineLogger;
  /**
   * The request pipeline user-signed actions and the Bridge2 deposit go through — absent on a
   * reads-only provider, whose `transfer`/`fund`/`userSigned` throw `not-enabled`.
   */
  readonly requests?: Pick<RequestController, "prepare" | "outcome" | "reject">;
  /**
   * The builder the AppsController confirmed for this group — `order` actions carry `builder: {b,
   * f}` only while this returns one; never above the confirmed maximum.
   */
  readonly builderFor?: (
    group: HyperliquidGroup,
  ) => { readonly address: string; readonly feeRateTenthsBps: number } | undefined;
};

const preview = (price: string, size: string, szDecimals: number): HyperliquidQuotePreview => {
  const roundedSize = roundSize(size, szDecimals);
  return {
    price,
    size: roundedSize,
    notional: notional(price, roundedSize),
    meetsMinimum: meetsMinimum(price, roundedSize),
  };
};

export function createHyperliquidProvider(
  options: HyperliquidProviderOptions,
): HyperliquidProvider & HyperliquidProviderInternals {
  const clock = createHyperliquidClock(options.now);
  const transport = createHyperliquidTransport({ ...options, clock });
  const config = { transport };
  const markets = createHyperliquidMarkets(config);
  const account = createHyperliquidAccount(config);
  const agents = createHyperliquidAgentRegistry({
    /* Deferred so a provider built for reads only does not need a live wallet object — the
       first agent or signing call resolves it. */
    agents: {
      listAgents: async () => hyperliquid(options.wallet).listAgents(),
    },
    evmAddress: async (group) => {
      // The signature chain names the group account: Arbitrum One / Sepolia (design §2).
      const account = await chains(options.wallet).account({
        walletId: group.walletId,
        groupIndex: group.groupIndex,
        template: "evm.bip44",
        network: options.network === "Mainnet" ? "eip155:42161" : "eip155:421614",
      });
      if (!("address" in account)) {
        throw new HyperliquidError("unavailable", "the group has no EVM address");
      }
      return account.address;
    },
    network: options.network,
    now: options.now,
    logger: options.logger,
  });
  const actions = createHyperliquidActions({
    markets,
    random: options.random,
    now: options.now,
  });
  const { requests } = options;
  const userSigned = createHyperliquidUserSigned({
    requests: requests ?? {
      prepare: () => {
        throw new HyperliquidError("not-enabled", "this provider has no request pipeline");
      },
      outcome: () => {
        throw new HyperliquidError("not-enabled", "this provider has no request pipeline");
      },
      reject: () => undefined,
    },
    transport,
    clock,
    markets,
    account,
    ownerOf: async (group) => agents.owner(group),
    network: options.network,
    now: options.now,
  });
  const exchange = createHyperliquidExchange({
    wallet: options.wallet,
    transport,
    clock,
    markets,
    account,
    registry: agents,
    now: options.now,
    setTimer: options.setTimer,
  });
  return {
    markets,
    account,
    quote: {
      limit: ({ price, size, side, szDecimals, market }) =>
        preview(limitPrice(price, side, szDecimals, market), size, szDecimals),
      market: ({ reference, size, side, slippageBps, szDecimals, market }) =>
        preview(slippagePrice(reference, side, slippageBps, szDecimals, market), size, szDecimals),
    },
    clock,
    trade: createHyperliquidTrade({
      actions,
      exchange,
      account,
      registry: agents,
      ...(options.builderFor === undefined ? {} : { builderFor: options.builderFor }),
    }),
    agents,
    userSigned,
    transfer: {
      toSpot: async (group, amount) =>
        userSigned.usdClassTransfer(group, { amount, toPerp: false }),
      toPerp: async (group, amount) => userSigned.usdClassTransfer(group, { amount, toPerp: true }),
      usdSend: async (group, params) => userSigned.usdSend(group, params),
      spotSend: async (group, params) => userSigned.spotSend(group, params),
      withdraw: async (group, params) => userSigned.withdraw(group, params),
    },
    fund: {
      depositInfo: HYPERLIQUID_DEPOSIT[options.network],
      deposit: async (group, { amount, fee }) => {
        const deposit = HYPERLIQUID_DEPOSIT[options.network];
        if (requests === undefined) {
          throw new HyperliquidError("not-enabled", "this provider has no request pipeline");
        }
        if (amount < deposit.minimum) {
          throw new HyperliquidError(
            "invalid-input",
            "deposits under 5 USDC are not credited by the bridge",
          );
        }
        const account = {
          kind: "hd" as const,
          walletId: group.walletId,
          groupIndex: group.groupIndex,
          template: "evm.bip44" as const,
        };
        const pending = await requests.prepare({
          method: "send",
          account,
          network: deposit.network,
          to: deposit.bridge,
          amount,
          token: deposit.usdc,
          fee,
        });
        const outcome = (async (): Promise<{ readonly kind: "ok" }> => {
          try {
            const result = await requests.outcome(pending.id);
            if (!("family" in result)) {
              throw new HyperliquidError(
                "unavailable",
                "the deposit request resolved without a transaction",
              );
            }
            return { kind: "ok" };
          } catch (error) {
            if (error instanceof RequestEndedError) {
              throw new HyperliquidError(
                "approval-rejected",
                `the request was ${error.stage}`,
                error,
              );
            }
            throw error;
          }
        })();
        return { requestId: pending.id, outcome };
      },
    },
  };
}
