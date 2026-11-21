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

/* CoW's GPv2 orders name the chain's native asset with this pseudo-address (cow-contracts
   GPv2Order; the UniswapX output token uses the zero address). */
const ETH_MARKER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * An order leg amount: the chain's native asset when `token` is the zero address or CoW's marker
 * (native symbol/decimals are attached by `withNativeAmountMeta` like every native amount), else
 * the ERC-20 address with symbol/decimals when the token is in the built-in table.
 */
export const orderAmount = (
  token: string,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
): AssetAmount => {
  const lower = token.toLowerCase();
  if (lower === ZERO || lower === ETH_MARKER) {
    return { asset: EVM_NATIVE_ASSET, amount: amount.toString(10) };
  }
  const found = lookupEvmToken(table, chainId, token);
  return {
    asset: token,
    amount: amount.toString(10),
    ...(found === undefined ? {} : { symbol: found.symbol, decimals: found.decimals }),
  };
};
