/**
 * Wrapped natives — WETH9-style contracts listed in the token table with role "wrapped-native".
 * `deposit()` mints the token to the caller for exactly msg.value and `withdraw(uint256)` burns the
 * token and returns the coin, so both describe as a swap whose other side is exact — verifiability
 * "full".
 */
import * as AbiFunction from "ox/AbiFunction";

import { ChainError } from "../index.ts";
import type { AssetFlow, DisplayIntent } from "../index.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { lookupEvmToken } from "./tokens.ts";
import { assertHex } from "./transaction.ts";

const DEPOSIT = AbiFunction.from("function deposit() payable");
const WITHDRAW = AbiFunction.from("function withdraw(uint256 wad)");

/** Canonical-encoding decode like `tryCall` in lido.ts — undefined on any mismatch. */
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
    const reencoded = AbiFunction.encodeData(fn, args);
    return reencoded.toLowerCase() === data.toLowerCase() ? args : undefined;
  } catch {
    return undefined;
  }
};

const argUint = (args: ReadonlyArray<unknown>, index: number): bigint => {
  const value = args[index];
  if (typeof value !== "bigint") {
    throw new ChainError("invalid-request", "decoded argument is not an integer");
  }
  return value;
};

/**
 * `caller` is the account the call runs as — msg.sender at `call.to`: the signer for a transaction
 * or batch call, the Safe or deposit wallet for an inner call. Minted or withdrawn assets go to
 * it.
 */
export const decodeWrappedNative = (
  chainId: number,
  call: { readonly to: string | undefined; readonly value: bigint; readonly data: string },
  caller: string,
  table: EvmTokenTable,
):
  | {
      readonly outflows: ReadonlyArray<AssetFlow>;
      readonly minimumReceived: NonNullable<DisplayIntent["minimumReceived"]>;
    }
  | undefined => {
  const token = call.to === undefined ? undefined : lookupEvmToken(table, chainId, call.to);
  if (call.to === undefined || token?.role !== "wrapped-native") {
    return undefined;
  }
  // deposit() takes no arguments: the canonical encoding is exactly the selector.
  if (call.data.toLowerCase() === AbiFunction.getSelector(DEPOSIT)) {
    return {
      outflows: [
        {
          to: call.to,
          amount: { asset: EVM_NATIVE_ASSET, amount: call.value.toString(10) },
          verified: true,
        },
      ],
      minimumReceived: [
        {
          to: caller,
          amount: {
            asset: call.to,
            amount: call.value.toString(10),
            symbol: token.symbol,
            decimals: token.decimals,
          },
        },
      ],
    };
  }
  const args = tryCall(WITHDRAW, call.data);
  /* Native value along a withdraw has no meaning — let the standard/blind path describe it. */
  if (args === undefined || call.value !== 0n) {
    return undefined;
  }
  const wad = argUint(args, 0);
  return {
    outflows: [
      {
        to: call.to,
        amount: {
          asset: call.to,
          amount: wad.toString(10),
          symbol: token.symbol,
          decimals: token.decimals,
        },
        verified: true,
      },
    ],
    minimumReceived: [
      { to: caller, amount: { asset: EVM_NATIVE_ASSET, amount: wad.toString(10) } },
    ],
  };
};
