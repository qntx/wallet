import type { AssetAmount } from "../index.ts";
/** Shared pieces of the off-chain order decoders (1inch LOP, UniswapX, CoW GPv2). */
import { EVM_NATIVE_ASSET } from "./assets.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";

/**
 * The most items any side of an order may carry before the document is too large to show in full:
 * Seaport offer/consideration, UniswapX outputs. Over the limit the decoder blinds the document
 * with `typed-data-oversize` rather than let the prompt truncate what it signs.
 */
export const ORDER_ITEMS = 8;

/**
 * An order leg amount: the chain's native asset when `token` matches `nativeMarker` — each protocol
 * names its own marker and the leg it applies to (UniswapX: the zero address, outputs only —
 * `CurrencyLibrary.NATIVE = address(0)`; CoW: `BUY_ETH_ADDRESS`, the buy token only); with no
 * marker every address is an ERC-20 (1inch signs no native asset). The native symbol/decimals are
 * attached by `withNativeAmountMeta` like every native amount; an ERC-20 gets symbol/decimals when
 * the token is in the built-in table.
 */
export const orderAmount = (
  token: string,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
  nativeMarker?: string,
): AssetAmount => {
  if (nativeMarker !== undefined && token.toLowerCase() === nativeMarker) {
    return { asset: EVM_NATIVE_ASSET, amount: amount.toString(10) };
  }
  const found = lookupEvmToken(table, chainId, token);
  return {
    asset: token,
    amount: amount.toString(10),
    ...(found === undefined ? {} : { symbol: found.symbol, decimals: found.decimals }),
  };
};
