import * as AbiFunction from "ox/AbiFunction";

import { ChainError } from "../index.ts";
import type {
  ApprovalChange,
  AssetFlow,
  DisplayIntent,
  EvmTransaction,
  MessageContent,
  SignRequest,
  Verifiability,
} from "../index.ts";
import { parseSignIn } from "../sign-in.ts";
import { checksumEvmAddress } from "./address.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import { lookupEvmToken, evmTokenTable } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { assertHex, networkChainId } from "./transaction.ts";
import { parseTypedData, typedDataWarnings } from "./typed-data.ts";

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
const PERMIT2_APPROVE = AbiFunction.from(
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
);
const PERMIT2_LOCKDOWN = AbiFunction.from(
  "function lockdown((address token, address spender)[] approvals)",
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

/** The canonical Permit2 deployment (the same address on every supported chain). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT160 = 2n ** 160n - 1n;

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

const weiAmount = (wei: bigint, symbol?: string, decimals?: number) => ({
  asset: EVM_NATIVE_ASSET,
  amount: wei.toString(10),
  ...(symbol === undefined ? {} : { symbol }),
  ...(decimals === undefined ? {} : { decimals }),
});

const feeWei = (tx: EvmTransaction): bigint =>
  BigInt(tx.gas) * (tx.type === "eip1559" ? BigInt(tx.maxFeePerGas) : BigInt(tx.gasPrice));

const nativeOutflow = (tx: EvmTransaction, to: string): ReadonlyArray<AssetFlow> => [
  { to, amount: weiAmount(BigInt(tx.value)), verified: true },
];

const tokenFlow = (
  tx: EvmTransaction,
  to: string,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
): { flows: ReadonlyArray<AssetFlow>; verified: boolean } => {
  const token = lookupEvmToken(table, chainId, tx.to ?? "");
  return {
    flows: [
      {
        to,
        amount: {
          asset: tx.to ?? "",
          amount: amount.toString(10),
          ...(token === undefined ? {} : { symbol: token.symbol, decimals: token.decimals }),
        },
        verified: token !== undefined,
      },
    ],
    verified: token !== undefined,
  };
};

const allowanceChange = (
  token: string,
  spender: string,
  value: bigint,
  change: "set" | "increase" | "decrease",
  max: bigint,
  chainId: number,
  table: EvmTokenTable,
  extra: { readonly expiration?: number; readonly via?: "permit2" } = {},
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

const argSeconds = (args: ReadonlyArray<unknown>, index: number): number => {
  const value = args[index];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new ChainError("invalid-request", "decoded argument is not an integer");
  }
  return Number(value);
};

const pairField = (pair: unknown, key: "token" | "spender"): string => {
  const value: unknown = typeof pair === "object" && pair !== null ? Reflect.get(pair, key) : "";
  return argAddress([value], 0);
};

const nftFlow = (asset: string, to: string, id: bigint): ReadonlyArray<AssetFlow> => [
  { to, amount: { asset, amount: id.toString(10) }, verified: false },
];

const decodeTransaction = (
  request: Extract<SignRequest, { kind: "evm.transaction" }>,
  table: EvmTokenTable,
): DisplayIntent => {
  const { tx } = request;
  const chainId = networkChainId(request.network);
  const data = tx.data.toLowerCase();
  const fee = { max: weiAmount(feeWei(tx)) };
  const base = { family: "evm" as const, network: request.network, approvals: [], warnings: [] };

  if (data === "0x") {
    if (tx.to === undefined) {
      return { ...base, summary: "contract-call", outflows: [], fee, verifiability: "opaque" };
    }
    return {
      ...base,
      summary: "transfer",
      outflows: nativeOutflow(tx, tx.to),
      fee,
      verifiability: "full",
    };
  }

  const transferArgs = tryCall(ERC20_TRANSFER, data);
  if (transferArgs !== undefined) {
    const { flows, verified } = tokenFlow(
      tx,
      argAddress(transferArgs, 0),
      argUint(transferArgs, 1),
      chainId,
      table,
    );
    return {
      ...base,
      summary: "transfer",
      outflows: flows,
      fee,
      verifiability: verified ? "full" : "partial",
    };
  }
  const partial = (
    summary: "approve" | "transfer",
    outflows: ReadonlyArray<AssetFlow>,
    approvals: ReadonlyArray<ApprovalChange>,
  ): DisplayIntent => ({
    ...base,
    summary,
    outflows,
    approvals,
    fee,
    verifiability: "partial",
  });
  const token = tx.to ?? "";

  if (token.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
    const permitArgs = tryCall(PERMIT2_APPROVE, data);
    if (permitArgs !== undefined) {
      const amount = argUint(permitArgs, 2);
      return partial(
        "approve",
        [],
        [
          allowanceChange(
            argAddress(permitArgs, 0),
            argAddress(permitArgs, 1),
            amount,
            "set",
            MAX_UINT160,
            chainId,
            table,
            { via: "permit2", expiration: argSeconds(permitArgs, 3) },
          ),
        ],
      );
    }
    const lockdownArgs = tryCall(PERMIT2_LOCKDOWN, data);
    if (lockdownArgs !== undefined) {
      return partial(
        "approve",
        [],
        argList(lockdownArgs, 0).map((pair) =>
          allowanceChange(
            pairField(pair, "token"),
            pairField(pair, "spender"),
            0n,
            "set",
            MAX_UINT160,
            chainId,
            table,
            { via: "permit2" },
          ),
        ),
      );
    }
  }
  for (const [fn, change] of [
    [ERC20_APPROVE, "set"],
    [ERC20_INCREASE, "increase"],
    [ERC20_DECREASE, "decrease"],
  ] as const) {
    const args = tryCall(fn, data);
    if (args !== undefined) {
      return partial(
        "approve",
        [],
        [
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
      );
    }
  }
  const operatorArgs = tryCall(SET_APPROVAL_FOR_ALL, data);
  if (operatorArgs !== undefined) {
    return partial(
      "approve",
      [],
      [
        {
          kind: "operator",
          asset: token,
          spender: argAddress(operatorArgs, 0),
          approved: argBool(operatorArgs, 1),
          verified: false,
        },
      ],
    );
  }
  const transferFromArgs = tryCall(ERC721_TRANSFER_FROM, data);
  if (transferFromArgs !== undefined) {
    const to = argAddress(transferFromArgs, 1);
    const id = argUint(transferFromArgs, 2);
    if (lookupEvmToken(table, chainId, token) !== undefined) {
      return partial("transfer", tokenFlow(tx, to, id, chainId, table).flows, []);
    }
    return partial("transfer", nftFlow(token, to, id), []);
  }
  for (const fn of [ERC721_SAFE_FROM, ERC721_SAFE_FROM_DATA]) {
    const args = tryCall(fn, data);
    if (args !== undefined) {
      return partial("transfer", nftFlow(token, argAddress(args, 1), argUint(args, 2)), []);
    }
  }
  const erc1155Args = tryCall(ERC1155_SAFE_FROM, data);
  if (erc1155Args !== undefined) {
    return partial(
      "transfer",
      nftFlow(token, argAddress(erc1155Args, 1), argUint(erc1155Args, 2)),
      [],
    );
  }
  const batchArgs = tryCall(ERC1155_SAFE_BATCH_FROM, data);
  if (batchArgs !== undefined) {
    const ids = argList(batchArgs, 2);
    if (ids.length > 0 && ids.length === argList(batchArgs, 3).length) {
      const to = argAddress(batchArgs, 1);
      return partial(
        "transfer",
        ids.flatMap((id) => nftFlow(token, to, argUint([id], 0))),
        [],
      );
    }
  }
  return { ...base, summary: "contract-call", outflows: [], fee, verifiability: "opaque" };
};

/** Strict UTF-8 text with any sign-in recognition, else the raw bytes as hex. */
const messageContent = (bytes: Uint8Array): MessageContent => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const signIn = parseSignIn(text, "evm");
    return signIn === undefined ? { kind: "text", text } : { kind: "text", text, signIn };
  } catch {
    return {
      kind: "bytes",
      hex: `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    };
  }
};

/** What the signer can guarantee about this request (WD-065). */
export const verifiabilityEvm = (request: SignRequest): Verifiability =>
  decodeEvm(request).verifiability;

/**
 * Decodes a normalized request into a DisplayIntent. The token table parameter is for tests;
 * production callers use the built-in table.
 */
export const decodeEvm = (
  request: SignRequest,
  table: EvmTokenTable = evmTokenTable,
): DisplayIntent => {
  if (request.kind === "evm.transaction") {
    return decodeTransaction(request, table);
  }
  if (request.kind === "evm.personal-message") {
    return {
      family: "evm",
      network: request.network,
      summary: "message",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: [],
      message: messageContent(request.message),
      verifiability: "opaque",
    };
  }
  if (request.kind !== "evm.typed-data") {
    throw new ChainError("unsupported", `unsupported sign request kind: ${request.kind}`);
  }
  const parsed = parseTypedData(request.typedData, request.network);
  return {
    family: "evm",
    network: request.network,
    summary: "message",
    outflows: [],
    approvals: [],
    fee: undefined,
    warnings: typedDataWarnings(parsed),
    verifiability: "opaque",
  };
};
