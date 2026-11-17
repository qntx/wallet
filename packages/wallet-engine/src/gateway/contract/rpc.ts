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
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "eth_simulateV1",
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

/** `eth_getLogs` is the one read whose cost the caller chooses: these bound it. */
export const LOGS_BLOCK_RANGE_MAX = 500;
export const LOGS_ADDRESS_MAX = 20;
export const LOGS_TOPIC_ALTERNATIVES_MAX = 20;

const quantity = z.string().check(z.regex(/^0x[0-9a-fA-F]{1,64}$/));
const hash32 = z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/));
const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));
/** The tags that name a recent block; `earliest` would make a range unbounded. */
const recentBlock = z.enum(["latest", "safe", "finalized", "pending"]);

const logsScope = {
  address: z.optional(
    z.union([evmAddress, z.array(evmAddress).check(z.minLength(1), z.maxLength(LOGS_ADDRESS_MAX))]),
  ),
  topics: z.optional(
    z
      .array(
        z.union([
          z.null(),
          hash32,
          z.array(hash32).check(z.maxLength(LOGS_TOPIC_ALTERNATIVES_MAX)),
        ]),
      )
      .check(z.maxLength(4)),
  ),
};
const logsFilter = z.union([
  z.strictObject({ ...logsScope, blockHash: hash32 }),
  z.strictObject({
    ...logsScope,
    fromBlock: z.optional(z.union([recentBlock, quantity])),
    toBlock: z.optional(z.union([recentBlock, quantity])),
  }),
]);

const isNumbered = (block: string | undefined): block is string => block?.startsWith("0x") === true;

/**
 * Why an `eth_getLogs` call is refused, or `undefined` when its filter is bounded: one block by
 * hash, a numbered range of at most {@link LOGS_BLOCK_RANGE_MAX} blocks, or recent-block tags.
 */
export function logsFilterViolation(params: unknown): string | undefined {
  const parsed = z.safeParse(z.tuple([logsFilter]), params);
  if (!parsed.success) {
    return `eth_getLogs takes one filter of at most ${LOGS_ADDRESS_MAX} addresses and ${LOGS_TOPIC_ALTERNATIVES_MAX} alternatives per topic, by blockHash or by a bounded block range`;
  }
  const [filter] = parsed.data;
  if ("blockHash" in filter) {
    return undefined;
  }
  const { fromBlock, toBlock } = filter;
  if (isNumbered(fromBlock) !== isNumbered(toBlock)) {
    return "eth_getLogs needs fromBlock and toBlock to be both block numbers or both block tags";
  }
  if (!isNumbered(fromBlock) || !isNumbered(toBlock)) {
    return undefined;
  }
  const span = BigInt(toBlock) - BigInt(fromBlock);
  return span < 0n || span >= BigInt(LOGS_BLOCK_RANGE_MAX)
    ? `eth_getLogs is limited to a range of ${LOGS_BLOCK_RANGE_MAX} blocks`
    : undefined;
}

export const evmRpcRequest = bodySchema(
  callSchema(z.enum(EVM_RPC_METHODS)).check(
    z.refine(
      (call) => call.method !== "eth_getLogs" || logsFilterViolation(call.params) === undefined,
    ),
  ),
);
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
