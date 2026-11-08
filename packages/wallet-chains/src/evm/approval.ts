import type { ApprovalChange } from "../index.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";

export const MAX_UINT256: bigint = 2n ** 256n - 1n;
export const MAX_UINT160: bigint = 2n ** 160n - 1n;

/** The canonical Permit2 deployment (the same address on every supported chain). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** A fungible-token allowance; `max` is the type's maximum, which marks it unlimited. */
export const allowanceChange = (
  token: string,
  spender: string,
  value: bigint,
  change: "set" | "increase" | "decrease" | "transfer",
  max: bigint,
  chainId: number,
  table: EvmTokenTable,
  extra: { readonly expiration?: number; readonly via?: "permit2" | "allowance-holder" } = {},
): ApprovalChange => {
  const known = lookupEvmToken(table, chainId, token);
  return {
    kind: "allowance",
    spender,
    amount: {
      asset: token,
      amount: value.toString(10),
      ...(known === undefined ? {} : { symbol: known.symbol, decimals: known.decimals }),
    },
    change,
    unlimited: change !== "decrease" && value === max,
    ...extra,
    verified: known !== undefined,
  };
};
