import * as AbiFunction from "ox/AbiFunction";

import { ChainError } from "../index.ts";
import type {
  ApprovalChange,
  AssetFlow,
  DisplayIntent,
  EvmTransaction,
  SignRequest,
  Verifiability,
} from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { lookupEvmToken, evmTokenTable } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { assertHex, networkChainId } from "./transaction.ts";
import { parseTypedData, typedDataWarnings } from "./typed-data.ts";

const ERC20_TRANSFER = AbiFunction.from("function transfer(address to, uint256 amount)");
const ERC20_APPROVE = AbiFunction.from("function approve(address spender, uint256 amount)");
const ERC20_INCREASE = AbiFunction.from(
  "function increaseAllowance(address spender, uint256 amount)",
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

const NATIVE_ASSET = "native";
const MAX_UINT256 = 2n ** 256n - 1n;

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
  asset: NATIVE_ASSET,
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

const approvalChange = (tx: EvmTransaction, spender: string, amount: bigint): ApprovalChange => ({
  asset: tx.to ?? "",
  spender,
  amount: amount.toString(10),
  unlimited: amount === MAX_UINT256,
  verified: false,
});

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
  const approveArgs = tryCall(ERC20_APPROVE, data);
  if (approveArgs !== undefined) {
    return {
      ...base,
      summary: "approve",
      outflows: [],
      approvals: [approvalChange(tx, argAddress(approveArgs, 0), argUint(approveArgs, 1))],
      fee,
      verifiability: "partial",
    };
  }
  const increaseArgs = tryCall(ERC20_INCREASE, data);
  if (increaseArgs !== undefined) {
    return {
      ...base,
      summary: "approve",
      outflows: [],
      approvals: [approvalChange(tx, argAddress(increaseArgs, 0), argUint(increaseArgs, 1))],
      fee,
      verifiability: "partial",
    };
  }
  for (const fn of [ERC721_TRANSFER_FROM, ERC721_SAFE_FROM]) {
    const args = tryCall(fn, data);
    if (args !== undefined) {
      return {
        ...base,
        summary: "transfer",
        outflows: nftFlow(tx.to ?? "", argAddress(args, 1), argUint(args, 2)),
        fee,
        verifiability: "partial",
      };
    }
  }
  const erc1155Args = tryCall(ERC1155_SAFE_FROM, data);
  if (erc1155Args !== undefined) {
    return {
      ...base,
      summary: "transfer",
      outflows: nftFlow(tx.to ?? "", argAddress(erc1155Args, 1), argUint(erc1155Args, 2)),
      fee,
      verifiability: "partial",
    };
  }
  return { ...base, summary: "contract-call", outflows: [], fee, verifiability: "opaque" };
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
      verifiability: "opaque",
    };
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
