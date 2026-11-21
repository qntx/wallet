import type { PublicClient } from "viem";

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
import { createHyperliquidLive } from "./live.ts";
import type { HyperliquidLive } from "./live.ts";
import { createHyperliquidMarkets } from "./markets.ts";
import type { HyperliquidMarkets } from "./markets.ts";
import { limitPrice, meetsMinimum, notional, roundSize, slippagePrice } from "./numbers.ts";
import type { HyperliquidMarket, OrderSide } from "./numbers.ts";
import type { HyperliquidSocket } from "./socket.ts";
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
  /** Funding moves on the signature chain: the CCTP deposit into Hyperliquid. */
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
  /**
   * Streaming views over the WebSocket transport — present only when the provider was built with a
   * `socket` (createApps always wires one). Market views need no unlocked wallet; user views
   * resolve the group to its owner and close on lock.
   */
  readonly live?: HyperliquidLive;
};

/**
 * The CCTP deposit: a `depositForBurnWithHook` on this chain's TokenMessengerV2 burns USDC and
 * Circle's CctpForwarder on HyperEVM (destination domain 19) mints it into the Hyperliquid account
 * — the legacy Bridge2 route is deprecated (docs §Deposits; research §H-1). Sources:
 *
 * - TokenMessengerV2 — https://developers.circle.com/cctp/references/contract-addresses
 * - USDC — https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - CctpForwarder — https://developers.circle.com/cctp/references/hypercore-contract-addresses
 */
export type HyperliquidDepositInfo = {
  /** The CCTP TokenMessengerV2 the deposit burns USDC through. */
  readonly tokenMessenger: string;
  /** The USDC contract the deposit spends. */
  readonly usdc: string;
  /** Circle's CctpForwarder on HyperEVM — mint recipient and destination caller. */
  readonly forwarder: string;
  /** The signature chain, CAIP-2. */
  readonly network: string;
  /** The Hyperliquid CCTP destination domain. */
  readonly destinationDomain: number;
  /** The confirmed-finality threshold the deposit requests (Circle's Fast Transfer 1000). */
  readonly minFinalityThreshold: number;
  /** The hook's dex selector for the account the deposit funds. */
  readonly dex: "perps" | "spot";
};

export const HYPERLIQUID_DEPOSIT: Record<"Mainnet" | "Testnet", HyperliquidDepositInfo> = {
  Mainnet: {
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    forwarder: "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757",
    network: "eip155:42161",
    destinationDomain: 19,
    minFinalityThreshold: 1000,
    dex: "perps",
  },
  Testnet: {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    forwarder: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2",
    network: "eip155:421614",
    destinationDomain: 19,
    minFinalityThreshold: 1000,
    dex: "perps",
  },
};

/** The Iris fee API host per network — the finality-1000 forward fee row feeds `maxFee`. */
const IRIS_FEES_URL: Record<"Mainnet" | "Testnet", string> = {
  Mainnet: "https://iris-api.circle.com/v2/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true",
  Testnet:
    "https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true",
};

/** The eth_call selectors the deposit reads: localMinter(), burnLimitsPerMessage, allowance. */
const SEL_LOCAL_MINTER = "0xcb75c11c";
const SEL_BURN_LIMIT = "0xa56ec632";
const SEL_ALLOWANCE = "0xdd62ed3e";

const ethCallWord = async (client: PublicClient, to: string, data: string): Promise<string> => {
  const result: unknown = await client.transport.request({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new HyperliquidError("unavailable", "the CCTP chain read answered malformed");
  }
  return result;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const word = (v: string): string => v.slice(2).toLowerCase().padStart(64, "0");

/**
 * The two-call CCTP deposit flow. When the messenger's USDC allowance is short, only the
 * exact-amount approve opens — the deposit call cannot be prepared yet (`eth_estimateGas` would
 * revert on-chain while the approval is unmined), so the host approves it and calls `deposit` again
 * once the approval confirmed; the re-read allowance then covers the amount and only the burn
 * request opens.
 */
export type HyperliquidDeposit =
  | {
      readonly kind: "approval-required";
      /** The exact-amount USDC approve for the TokenMessengerV2. */
      readonly approval: HyperliquidPendingAction;
    }
  | {
      readonly kind: "deposit";
      /** The `depositForBurnWithHook` transaction. */
      readonly deposit: HyperliquidPendingAction;
    };

/** What the Iris forward-fee endpoint contributes: flat fee + the burn's bps minimum. */
const fetchMaxFee = async (
  fetcher: typeof globalThis.fetch,
  url: string,
  amount: bigint,
): Promise<bigint> => {
  let body: unknown;
  try {
    const res = await fetcher(url);
    body = res.ok ? await res.json() : undefined;
  } catch {
    body = undefined;
  }
  const rows = Array.isArray(body) ? body.filter(isObject) : [];
  const row = rows.find(
    (r): r is Record<string, unknown> & { minimumFee: number; forwardFee: { high: number } } =>
      r["finalityThreshold"] === 1000 &&
      typeof r["minimumFee"] === "number" &&
      isObject(r["forwardFee"]) &&
      typeof r["forwardFee"]["high"] === "number",
  );
  if (
    row === undefined ||
    !Number.isInteger(row.minimumFee) ||
    row.minimumFee < 0 ||
    !Number.isInteger(row.forwardFee.high) ||
    row.forwardFee.high < 0
  ) {
    throw new HyperliquidError("unavailable", "the Circle fee endpoint answered malformed");
  }
  return BigInt(row.forwardFee.high) + (amount * BigInt(row.minimumFee) + 9999n) / 10_000n;
};

/** The per-message burn limit for this route's USDC — `localMinter` → `burnLimitsPerMessage`. */
const readBurnLimit = async (
  client: PublicClient,
  messenger: string,
  usdc: string,
): Promise<bigint> => {
  const minterWord = await ethCallWord(client, messenger, SEL_LOCAL_MINTER);
  const minter = minterWord.slice(26);
  if (!/^[0-9a-fA-F]{40}$/.test(minter)) {
    throw new HyperliquidError("unavailable", "the messenger answered no local minter");
  }
  return BigInt(await ethCallWord(client, `0x${minter}`, `${SEL_BURN_LIMIT}${word(usdc)}`));
};

/** `allowance(owner, spender)` on the route's USDC. */
const readAllowance = async (
  client: PublicClient,
  usdc: string,
  owner: string,
  spender: string,
): Promise<bigint> =>
  BigInt(await ethCallWord(client, usdc, `${SEL_ALLOWANCE}${word(owner)}${word(spender)}`));

export type HyperliquidFund = {
  /** The CCTP route constants for the provider's network. */
  readonly depositInfo: HyperliquidDepositInfo;
  /**
   * Fund the Hyperliquid account from the group's Arbitrum USDC through Circle's CCTP: an
   * exact-amount `approve` to the TokenMessengerV2 when the allowance is short, then a
   * `depositForBurnWithHook` routed to the CctpForwarder (domain 19, finality 1000). `amount` is
   * USDC base units (6 decimals); it must exceed the Circle fee and fit the per-message burn limit.
   * Both request outcomes are reported.
   */
  readonly deposit: (
    group: HyperliquidGroup,
    params: {
      readonly amount: bigint;
      readonly fee: EvmFeeTier;
      /** Which Hyperliquid account the deposit funds — `depositInfo.dex` when omitted. */
      readonly dex?: "perps" | "spot";
    },
  ) => Promise<HyperliquidDeposit>;
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
   * The request pipeline user-signed actions and the CCTP deposit go through — absent on a
   * reads-only provider, whose `transfer`/`fund`/`userSigned` throw `not-enabled`.
   */
  readonly requests?: Pick<RequestController, "prepare" | "outcome" | "reject">;
  /**
   * The chain clients `deposit` reads allowance and the CCTP burn limit through — absent on a
   * reads-only provider.
   */
  readonly networks?: { readonly client: (network: string) => PublicClient };
  /**
   * The builder the AppsController confirmed for this group — `order` actions carry `builder: {b,
   * f}` only while this returns one; never above the confirmed maximum.
   */
  readonly builderFor?: (
    group: HyperliquidGroup,
  ) => { readonly address: string; readonly feeRateTenthsBps: number } | undefined;
  /** The injected WebSocket transport live views stream over — absent on reads-only rigs. */
  readonly socket?: HyperliquidSocket;
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
    ...(options.socket === undefined
      ? {}
      : {
          live: createHyperliquidLive({
            socket: options.socket,
            transport,
            ownerOf: async (group) => agents.owner(group),
            now: options.now,
            setTimer: options.setTimer,
            random: options.random,
            wallet: options.wallet,
          }),
        }),
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
      deposit: async (group, { amount, fee, dex }) => {
        const route = HYPERLIQUID_DEPOSIT[options.network];
        if (requests === undefined || options.networks === undefined) {
          throw new HyperliquidError("not-enabled", "this provider has no request pipeline");
        }
        const client = options.networks.client(route.network);
        const owner = await agents.owner(group);
        /* The Circle fee bound is read before any request is opened: a deposit it would
           consume, or a fee answer we cannot parse, is refused with no prompt shown. */
        const maxFee = await fetchMaxFee(options.fetch, IRIS_FEES_URL[options.network], amount);
        if (amount <= maxFee) {
          throw new HyperliquidError(
            "invalid-input",
            "the Circle fee would consume the whole deposit",
          );
        }
        const limit = await readBurnLimit(client, route.tokenMessenger, route.usdc);
        if (amount > limit) {
          throw new HyperliquidError(
            "invalid-input",
            "the deposit exceeds the per-message burn limit",
          );
        }
        const account = {
          kind: "hd" as const,
          walletId: group.walletId,
          groupIndex: group.groupIndex,
          template: "evm.bip44" as const,
        };
        const track = (pending: { readonly id: string }): HyperliquidPendingAction => ({
          requestId: pending.id,
          outcome: (async (): Promise<{ readonly kind: "ok" }> => {
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
          })(),
        });
        /* An exact-amount approve only when the allowance is short — the pipeline itself
           refuses an overwrite of a nonzero allowance, so the read must come first. The deposit
           request is not prepared here: its estimateGas reverts on a real chain while the
           approval is unmined. The host calls `deposit` again after the approval confirmed. */
        const allowance = await readAllowance(client, route.usdc, owner, route.tokenMessenger);
        if (allowance < amount) {
          return {
            kind: "approval-required",
            approval: track(
              await requests.prepare({
                method: "evm-approve",
                account,
                network: route.network,
                token: route.usdc,
                spender: route.tokenMessenger,
                amount,
                fee,
              }),
            ),
          };
        }
        return {
          kind: "deposit",
          deposit: track(
            await requests.prepare({
              method: "evm-cctp",
              account,
              network: route.network,
              amount,
              dex: dex ?? route.dex,
              maxFee,
              fee,
            }),
          ),
        };
      },
    },
  };
}
