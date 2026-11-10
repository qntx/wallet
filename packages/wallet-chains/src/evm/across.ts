import * as AbiFunction from "ox/AbiFunction";

import type { AssetAmount } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { lookupEvmToken } from "./tokens.ts";
import { assertHex } from "./transaction.ts";

/**
 * Across SpokePool proxies per origin chain — UUPS upgradeable, so the kernel recognises them by
 * address only. Verified against the Across deployments registry on 2026-11-08.
 */
export const ACROSS_SPOKEPOOLS: Readonly<Record<number, string>> = {
  1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  10: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
  56: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
  137: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
  999: "0x35E63eA3eb0fb7A3bc543C71FB66412e1F6B0E04",
  8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  43114: "0xFE9D541c92E4e90437C7152A00244886dE37a658",
  11155111: "0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662",
};

/** Each pool's `wrappedNativeToken()` — read on-chain on 2026-11-08. */
export const ACROSS_WRAPPED_NATIVE: Readonly<Record<number, string>> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  10: "0x4200000000000000000000000000000000000006",
  56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  137: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  999: "0x5555555555555555555555555555555555555555",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  43114: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  11155111: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
};

const DEPOSIT = AbiFunction.from(
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
);
const DEPOSIT_V3 = AbiFunction.from(
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message)",
);

/** Canonical-encoding decode like `tryCall` in decode.ts — undefined on any mismatch. */
const tryCall = (fn: AbiFunction.AbiFunction, data: string): ReadonlyArray<unknown> | undefined => {
  const selector = AbiFunction.getSelector(fn);
  if (!data.toLowerCase().startsWith(selector)) {
    return undefined;
  }
  try {
    assertHex(data, "data");
    const args: unknown = AbiFunction.decodeData(fn, data);
    if (!Array.isArray(args)) {
      return undefined;
    }
    const reencoded = AbiFunction.encodeData(fn, args).toLowerCase();
    // The Across SDK appends a data suffix after the canonical ABI blob; the EVM executes the
    // same call either way, so the canonical encoding is required as a prefix, not as the whole.
    return data.toLowerCase().startsWith(reencoded) ? args : undefined;
  } catch {
    return undefined;
  }
};

/** A bytes32 carrying an EVM address must be left-padded; anything else is a non-EVM target. */
const paddedAddress = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return undefined;
  }
  if (value.slice(2, 26) !== "000000000000000000000000") {
    return undefined;
  }
  return checksumEvmAddress(`0x${value.slice(26)}`);
};

const tokenAmount = (
  table: EvmTokenTable | undefined,
  chainId: number,
  token: string,
  amount: bigint,
): AssetAmount => {
  const meta = table === undefined ? undefined : lookupEvmToken(table, chainId, token);
  return meta === undefined
    ? { asset: token, amount: amount.toString(10) }
    : { asset: token, amount: amount.toString(10), decimals: meta.decimals, symbol: meta.symbol };
};

const argUint = (args: ReadonlyArray<unknown>, index: number): bigint | undefined => {
  const v = args[index];
  return typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : undefined;
};

const argAddress = (args: ReadonlyArray<unknown>, index: number): string | undefined => {
  const v = args[index];
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? checksumEvmAddress(v) : undefined;
};

export type AcrossBridge = {
  readonly outflows: ReadonlyArray<{
    readonly to: string;
    readonly amount: AssetAmount;
    readonly verified: boolean;
  }>;
  readonly minimumReceived: ReadonlyArray<{
    readonly to: string;
    readonly amount: AssetAmount;
    readonly verified: boolean;
  }>;
  readonly bridge: {
    readonly destinationNetwork: string;
    readonly fillDeadline: number;
    readonly refundTo: string;
  };
};

/**
 * Decodes a `deposit`/`depositV3` to the chain's SpokePool — empty `message` only; bytes32 fields
 * must carry left-padded EVM addresses (non-EVM destinations are not recognised). The deposit
 * guarantees `outputAmount` on the destination chain or a refund to `depositor` after
 * `fillDeadline`, so the intent's `minimumReceived` and `bridge` fields carry those terms.
 */
export const decodeAcross = (
  chainId: number,
  call: { to: string | undefined; data: string; value: bigint },
  table?: EvmTokenTable,
): AcrossBridge | undefined => {
  const pool = ACROSS_SPOKEPOOLS[chainId];
  if (pool === undefined || call.to === undefined || call.to.toLowerCase() !== pool.toLowerCase()) {
    return undefined;
  }
  const v4 = tryCall(DEPOSIT, call.data);
  const v3 = v4 === undefined ? tryCall(DEPOSIT_V3, call.data) : undefined;
  if (v4 === undefined && v3 === undefined) {
    return undefined;
  }
  const args = v4 ?? v3 ?? [];
  const [depositor, recipient, inputToken, outputToken] = [0, 1, 2, 3].map((i) =>
    v4 === undefined ? argAddress(args, i) : paddedAddress(args[i]),
  );
  if (
    depositor === undefined ||
    recipient === undefined ||
    inputToken === undefined ||
    outputToken === undefined
  ) {
    return undefined;
  }
  const inputAmount = argUint(args, 4);
  const outputAmount = argUint(args, 5);
  const destinationChainId = argUint(args, 6);
  const fillDeadline = argUint(args, 9);
  const message = args.at(11);
  if (
    inputAmount === undefined ||
    outputAmount === undefined ||
    destinationChainId === undefined ||
    fillDeadline === undefined ||
    message !== "0x"
  ) {
    return undefined;
  }
  // Native deposits forward exactly `inputAmount` as msg.value; any other value attached to the
  // call would leave the intent without that outflow, so the call is not recognised.
  const native =
    call.value > 0n &&
    inputToken.toLowerCase() === (ACROSS_WRAPPED_NATIVE[chainId] ?? "").toLowerCase();
  if (call.value > 0n && (!native || call.value !== inputAmount)) {
    return undefined;
  }
  return {
    outflows: [
      {
        to: pool,
        amount: native
          ? { asset: EVM_NATIVE_ASSET, amount: call.value.toString(10) }
          : tokenAmount(table, chainId, inputToken, inputAmount),
        verified: true,
      },
    ],
    minimumReceived: [
      {
        to: recipient,
        amount: tokenAmount(table, Number(destinationChainId), outputToken, outputAmount),
        verified: true,
      },
    ],
    bridge: {
      destinationNetwork: `eip155:${destinationChainId.toString(10)}`,
      fillDeadline: Number(fillDeadline),
      refundTo: depositor,
    },
  };
};
