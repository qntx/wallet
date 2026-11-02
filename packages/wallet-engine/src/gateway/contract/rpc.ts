import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

/** One JSON-RPC call plus nothing else: batches may carry at most this many entries. */
export const RPC_BATCH_MAX = 20;

/** Read-only EVM methods plus `eth_sendRawTransaction`. Anything not listed is rejected. */
export const EVM_RPC_METHODS = [
  "eth_blobBaseFee",
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "net_version",
  "web3_clientVersion",
] as const;

/** Read-only Solana methods plus `sendTransaction`. Anything not listed is rejected. */
export const SOLANA_RPC_METHODS = [
  "getAccountInfo",
  "getBalance",
  "getBlock",
  "getBlockHeight",
  "getBlockTime",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
] as const;

export type EvmRpcMethod = (typeof EVM_RPC_METHODS)[number];
export type SolanaRpcMethod = (typeof SOLANA_RPC_METHODS)[number];

export const jsonRpcId = z.union([z.string(), z.number(), z.null()]);

const jsonRpcParams = z.optional(
  z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
);

const callSchema = <M extends z.ZodMiniType<string>>(method: M) =>
  z.object({ jsonrpc: z.literal("2.0"), id: jsonRpcId, method, params: jsonRpcParams });

const bodySchema = <C extends z.ZodMiniType>(call: C) =>
  z.union([call, z.array(call).check(z.minLength(1), z.maxLength(RPC_BATCH_MAX))]);

/** Method-agnostic wire shape of a call or batch (the gateway narrows by family). */
export const rpcRequest = bodySchema(callSchema(z.string()));

export const evmRpcRequest = bodySchema(callSchema(z.enum(EVM_RPC_METHODS)));
export const solanaRpcRequest = bodySchema(callSchema(z.enum(SOLANA_RPC_METHODS)));

const successResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcId,
  result: z.unknown(),
});
const errorResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcId,
  error: z.object({ code: z.int(), message: z.string(), data: z.optional(z.unknown()) }),
});

export const jsonRpcResponse = z.union([successResponse, errorResponse]);
export const rpcResponse = z.union([jsonRpcResponse, z.array(jsonRpcResponse)]);

export const rpc = endpoint("POST", "/v1/rpc/:caip2", rpcRequest, rpcResponse);

/** The JSON-RPC URL path for one network. */
export const rpcPath = (caip2: string): string => rpc.path.replace(":caip2", caip2);
