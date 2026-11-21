import type { Wallet } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { hyperliquid } from "@qntx/wallet/hyperliquid";

import type { EngineLogger } from "../../events.ts";
import { createHyperliquidAccount } from "./account.ts";
import type { HyperliquidAccount } from "./account.ts";
import { createHyperliquidActions } from "./actions.ts";
import { createHyperliquidAgentRegistry } from "./agents.ts";
import type { HyperliquidAgentRegistry } from "./agents.ts";
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
  /**
   * The kernel-agent registry `trade` uses — the layer-3 controller drives `refresh`,
   * `markEnabled`, and sees `markRejected` latch rejections from the exchange path.
   */
  readonly agents: HyperliquidAgentRegistry;
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
): HyperliquidProvider {
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
    trade: createHyperliquidTrade({ actions, exchange, account, registry: agents }),
    agents,
  };
}
