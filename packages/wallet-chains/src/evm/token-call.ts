/**
 * The ERC-20/721/1155 selector table shared with TRON's TRC-20 decoding — its own module so the
 * TRON bundle does not pull the rest of the EVM decoder (0x, Across, Lido, Seaport, Safe,
 * typed-data). Permit2's approve/lockdown stay in decode.ts: they are gated on the Permit2 address,
 * which a TRC-20 callee never is.
 */
import * as AbiFunction from "ox/AbiFunction";

import { ChainError } from "../index.ts";
import type { ApprovalChange, AssetFlow } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { MAX_UINT256, allowanceChange } from "./approval.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";

const ERC20_TRANSFER = AbiFunction.from("function transfer(address to, uint256 amount)");
const ERC20_APPROVE = AbiFunction.from("function approve(address spender, uint256 amount)");
const ERC20_INCREASE = AbiFunction.from(
  "function increaseAllowance(address spender, uint256 amount)",
);
const ERC20_DECREASE = AbiFunction.from(
  "function decreaseAllowance(address spender, uint256 subtractedValue)",
);
const SET_APPROVAL_FOR_ALL = AbiFunction.from(
  "function setApprovalForAll(address operator, bool approved)",
);
const ERC721_SAFE_FROM_DATA = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
);
const ERC1155_SAFE_BATCH_FROM = AbiFunction.from(
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)",
);
const ERC721_TRANSFER_FROM = AbiFunction.from(
  "function transferFrom(address from, address to, uint256 tokenId)",
);
const ERC721_SAFE_FROM = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
);
const ERC1155_SAFE_FROM = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
);

function assertHex(data: string): asserts data is `0x${string}` {
  if (!/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new ChainError("invalid-request", "call data is not 0x-prefixed hex");
  }
}

const argAddress = (args: ReadonlyArray<unknown>, index: number): string => {
  const value = args[index];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ChainError("invalid-request", "decoded argument is not an address");
  }
  return checksumEvmAddress(value);
};

const argUint = (args: ReadonlyArray<unknown>, index: number): bigint => {
  const value = args[index];
  if (typeof value !== "bigint") {
    throw new ChainError("invalid-request", "decoded argument is not a uint256");
  }
  return value;
};

/**
 * Decodes `data` as `fn` and verifies the encoding is canonical (re-encoding the decoded args
 * reproduces the input byte-for-byte). Returns undefined on selector mismatch, decode failure or a
 * non-canonical encoding — the caller falls through to the next candidate or the opaque class.
 */
const tryCall = (fn: AbiFunction.AbiFunction, data: string): ReadonlyArray<unknown> | undefined => {
  const selector = AbiFunction.getSelector(fn);
  if (!data.toLowerCase().startsWith(selector)) {
    return undefined;
  }
  try {
    assertHex(data);
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

const tokenFlow = (
  target: string,
  to: string,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
): { flows: ReadonlyArray<AssetFlow>; verified: boolean } => {
  const token = lookupEvmToken(table, chainId, target);
  return {
    flows: [
      {
        to,
        amount: {
          asset: target,
          amount: amount.toString(10),
          ...(token === undefined ? {} : { symbol: token.symbol, decimals: token.decimals }),
        },
        verified: token !== undefined,
      },
    ],
    verified: token !== undefined,
  };
};

const argBool = (args: ReadonlyArray<unknown>, index: number): boolean => {
  const value = args[index];
  if (typeof value !== "boolean") {
    throw new ChainError("invalid-request", "decoded argument is not a bool");
  }
  return value;
};

const argList = (args: ReadonlyArray<unknown>, index: number): ReadonlyArray<unknown> => {
  const value = args[index];
  if (!Array.isArray(value)) {
    throw new ChainError("invalid-request", "decoded argument is not an array");
  }
  return value;
};

const nftFlow = (asset: string, to: string, id: bigint, value = 1n): ReadonlyArray<AssetFlow> => [
  {
    to,
    amount: { asset, amount: value.toString(10), tokenId: id.toString(10) },
    verified: false,
  },
];

/** The token-standard decode of a call's calldata — what `standardIntent` returns minus the fee. */
export type TokenCall = {
  readonly summary: "transfer" | "approve";
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly approvals: ReadonlyArray<
    Extract<ApprovalChange, { readonly kind: "allowance" | "operator" }>
  >;
  readonly verifiability: "full" | "partial";
};

/**
 * The token-standard selectors, in the same order the EVM decoder tries them: transfer,
 * approve/increaseAllowance/decreaseAllowance, setApprovalForAll, transferFrom, the two ERC-721
 * safeTransferFrom forms, then ERC-1155 single and batch. `token` is the callee, `data` 0x hex.
 */
export const decodeTokenCall = (
  token: string,
  data: string,
  chainId: number,
  table: EvmTokenTable,
): TokenCall | undefined => {
  const transferArgs = tryCall(ERC20_TRANSFER, data);
  if (transferArgs !== undefined) {
    const { flows, verified } = tokenFlow(
      token,
      argAddress(transferArgs, 0),
      argUint(transferArgs, 1),
      chainId,
      table,
    );
    return {
      summary: "transfer",
      outflows: flows,
      approvals: [],
      verifiability: verified ? "full" : "partial",
    };
  }
  for (const [fn, change] of [
    [ERC20_APPROVE, "set"],
    [ERC20_INCREASE, "increase"],
    [ERC20_DECREASE, "decrease"],
  ] as const) {
    const args = tryCall(fn, data);
    if (args !== undefined) {
      return {
        summary: "approve",
        outflows: [],
        approvals: [
          allowanceChange(
            token,
            argAddress(args, 0),
            argUint(args, 1),
            change,
            MAX_UINT256,
            chainId,
            table,
          ),
        ],
        verifiability: "partial",
      };
    }
  }
  const operatorArgs = tryCall(SET_APPROVAL_FOR_ALL, data);
  if (operatorArgs !== undefined) {
    return {
      summary: "approve",
      outflows: [],
      approvals: [
        {
          kind: "operator",
          asset: token,
          spender: argAddress(operatorArgs, 0),
          approved: argBool(operatorArgs, 1),
          verified: false,
        },
      ],
      verifiability: "partial",
    };
  }
  const transferFromArgs = tryCall(ERC721_TRANSFER_FROM, data);
  if (transferFromArgs !== undefined) {
    const to = argAddress(transferFromArgs, 1);
    const id = argUint(transferFromArgs, 2);
    if (lookupEvmToken(table, chainId, token) !== undefined) {
      return {
        summary: "transfer",
        outflows: tokenFlow(token, to, id, chainId, table).flows,
        approvals: [],
        verifiability: "partial",
      };
    }
    return {
      summary: "transfer",
      outflows: nftFlow(token, to, id),
      approvals: [],
      verifiability: "partial",
    };
  }
  for (const fn of [ERC721_SAFE_FROM, ERC721_SAFE_FROM_DATA]) {
    const args = tryCall(fn, data);
    if (args !== undefined) {
      return {
        summary: "transfer",
        outflows: nftFlow(token, argAddress(args, 1), argUint(args, 2)),
        approvals: [],
        verifiability: "partial",
      };
    }
  }
  const erc1155Args = tryCall(ERC1155_SAFE_FROM, data);
  if (erc1155Args !== undefined) {
    return {
      summary: "transfer",
      outflows: nftFlow(
        token,
        argAddress(erc1155Args, 1),
        argUint(erc1155Args, 2),
        argUint(erc1155Args, 3),
      ),
      approvals: [],
      verifiability: "partial",
    };
  }
  const batchArgs = tryCall(ERC1155_SAFE_BATCH_FROM, data);
  if (batchArgs !== undefined) {
    const ids = argList(batchArgs, 2);
    const values = argList(batchArgs, 3);
    if (ids.length > 0 && ids.length === values.length) {
      const to = argAddress(batchArgs, 1);
      return {
        summary: "transfer",
        outflows: ids.flatMap((id, i) =>
          nftFlow(token, to, argUint([id], 0), argUint([values[i] ?? 0n], 0)),
        ),
        approvals: [],
        verifiability: "partial",
      };
    }
  }
  return undefined;
};
