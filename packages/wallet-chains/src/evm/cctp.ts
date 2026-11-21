import * as AbiFunction from "ox/AbiFunction";

import type { AssetAmount } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { lookupEvmToken } from "./tokens.ts";
import { assertHex } from "./transaction.ts";

/**
 * CCTP TokenMessengerV2 `depositForBurnWithHook` deposits USDC into Hyperliquid via Circle's
 * CctpForwarder on HyperEVM (destination domain 19). Only the Hyperliquid route is described — a
 * call to the messenger on these chains that does not match it exactly is blind
 * (`cctp-destination`): an unrecognised hook could send the burn anywhere.
 *
 * Sources: Circle's CCTP contract addresses (evidence H-1 `onchain-code.txt`) and the forwarder
 * addresses from the Hyperliquid docs (evidence H-1), verified 2026-11-21.
 */
export const CCTP_MESSENGERS: Readonly<Record<number, string>> = {
  42161: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  421614: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
};

export const CCTP_USDC: Readonly<Record<number, string>> = {
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
};

/** Circle's CctpForwarder on HyperEVM (999 mainnet, 998 testnet) — the mint recipient domain 19. */
export const CCTP_FORWARDERS: Readonly<Record<number, string>> = {
  42161: "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757",
  421614: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2",
};

export const HYPERLIQUID_DOMAIN = 19;

const DEPOSIT_WITH_HOOK = AbiFunction.from(
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
);

/** `call.to` is this chain's TokenMessengerV2 — the call is CCTP territory, described or blind. */
export const isCctpMessenger = (chainId: number, to: string | undefined): boolean =>
  to !== undefined && to.toLowerCase() === CCTP_MESSENGERS[chainId]?.toLowerCase();

/** Strict canonical decode — unlike Across, no calldata suffix is tolerated. */
const tryCall = (fn: AbiFunction.AbiFunction, data: string): ReadonlyArray<unknown> | undefined => {
  if (!data.toLowerCase().startsWith(AbiFunction.getSelector(fn))) {
    return undefined;
  }
  try {
    assertHex(data, "data");
    const args: unknown = AbiFunction.decodeData(fn, data);
    if (!Array.isArray(args)) {
      return undefined;
    }
    return AbiFunction.encodeData(fn, args).toLowerCase() === data.toLowerCase() ? args : undefined;
  } catch {
    return undefined;
  }
};

const paddedAddress = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return undefined;
  }
  if (value.slice(2, 26) !== "000000000000000000000000") {
    return undefined;
  }
  return checksumEvmAddress(`0x${value.slice(26)}`);
};

/* ASCII "cctp-forward" — the forwarder hook's 12-byte tag. */
const FORWARD_PREFIX_HEX = "636374702d666f7277617264";

/** The 56-byte Hyperliquid forward hook: tag, zeros, version 0, length 24, recipient, dex. */
const decodeHook = (
  value: unknown,
  from: string,
): { recipient: string; dex: "perps" | "spot" } | undefined => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{112}$/.test(value)) {
    return undefined;
  }
  const hex = value.slice(2);
  if (!hex.startsWith(FORWARD_PREFIX_HEX)) {
    return undefined;
  }
  if (hex.slice(24, 48) !== "000000000000000000000000") {
    return undefined;
  }
  if (hex.slice(48, 56) !== "00000000" || hex.slice(56, 64) !== "00000018") {
    return undefined;
  }
  const recipient = checksumEvmAddress(`0x${hex.slice(64, 104)}`);
  if (recipient.toLowerCase() !== from.toLowerCase()) {
    return undefined;
  }
  const dex = hex.slice(104, 112);
  if (dex !== "00000000" && dex !== "ffffffff") {
    return undefined;
  }
  return { recipient, dex: dex === "00000000" ? "perps" : "spot" };
};

export type CctpDeposit = {
  readonly outflows: ReadonlyArray<{
    readonly to: string;
    readonly amount: AssetAmount;
    readonly verified: boolean;
  }>;
  readonly hyperliquidDeposit: {
    readonly recipient: string;
    readonly dex: "perps" | "spot";
    readonly maxFee: AssetAmount;
  };
};

/**
 * A fully described Hyperliquid deposit: the burn is bounded by `amount` USDC to this chain's
 * verified TokenMessengerV2, routed to the forwarder on domain 19, and the hook commits the
 * depositor's own address plus a perps/spot dex and a `maxFee` strictly below the amount.
 */
export const decodeCctp = (
  chainId: number,
  call: { to: string | undefined; data: string; value: bigint },
  from: string,
  table?: EvmTokenTable,
): CctpDeposit | undefined => {
  const messenger = CCTP_MESSENGERS[chainId];
  const usdc = CCTP_USDC[chainId];
  const forwarder = CCTP_FORWARDERS[chainId];
  if (
    messenger === undefined ||
    usdc === undefined ||
    forwarder === undefined ||
    !isCctpMessenger(chainId, call.to) ||
    call.value !== 0n
  ) {
    return undefined;
  }
  const args = tryCall(DEPOSIT_WITH_HOOK, call.data);
  if (args === undefined) {
    return undefined;
  }
  const [amount, domain, mintRecipient, burnToken, destinationCaller, maxFee] = args;
  const burn =
    typeof burnToken === "string" && /^0x[0-9a-fA-F]{40}$/.test(burnToken)
      ? checksumEvmAddress(burnToken)
      : undefined;
  if (
    typeof amount !== "bigint" ||
    typeof maxFee !== "bigint" ||
    domain !== HYPERLIQUID_DOMAIN ||
    burn === undefined ||
    burn.toLowerCase() !== usdc.toLowerCase() ||
    paddedAddress(mintRecipient)?.toLowerCase() !== forwarder.toLowerCase() ||
    paddedAddress(destinationCaller)?.toLowerCase() !== forwarder.toLowerCase() ||
    maxFee <= 0n ||
    maxFee >= amount
  ) {
    return undefined;
  }
  const hook = decodeHook(args.at(7), from);
  if (hook === undefined) {
    return undefined;
  }
  const meta = table === undefined ? undefined : lookupEvmToken(table, chainId, usdc);
  const amountOf = (v: bigint): AssetAmount =>
    meta === undefined
      ? { asset: usdc, amount: v.toString(10) }
      : { asset: usdc, amount: v.toString(10), decimals: meta.decimals, symbol: meta.symbol };
  return {
    outflows: [{ to: messenger, amount: amountOf(amount), verified: true }],
    hyperliquidDeposit: {
      recipient: hook.recipient,
      dex: hook.dex,
      maxFee: amountOf(maxFee),
    },
  };
};
