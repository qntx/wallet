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
  "getStakeMinimumDelegation",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
  "getVoteAccounts",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
] as const;

export type EvmRpcMethod = (typeof EVM_RPC_METHODS)[number];
export type SolanaRpcMethod = (typeof SOLANA_RPC_METHODS)[number];

/** Methods that relay a signed transaction — retrying one can double-broadcast it. */
export const RPC_BROADCAST_METHODS = ["eth_sendRawTransaction", "sendTransaction"] as const;

/**
 * A request id is an int or a short string the caller chose — never `null`. `null` only exists on
 * responses, where it reports a request that could not be parsed at all ({@link jsonRpcId}).
 */
export const jsonRpcRequestId = z.union([z.int(), z.string().check(z.maxLength(64))]);

/** A response id echoes the request's; a parse-level error legitimately answers with `null`. */
export const jsonRpcId = z.union([z.string(), z.number(), z.null()]);

const jsonRpcParams = z.optional(
  z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
);

const callSchema = <M extends z.ZodMiniType<string>>(method: M, params: z.ZodMiniType) =>
  z.object({ jsonrpc: z.literal("2.0"), id: jsonRpcRequestId, method, params });

const bodySchema = <C extends z.ZodMiniType>(call: C) =>
  z.union([call, z.array(call).check(z.minLength(1), z.maxLength(RPC_BATCH_MAX))]);

/** Method-agnostic wire shape of a call or batch (the gateway narrows by family). */
export const rpcRequest = bodySchema(callSchema(z.string(), jsonRpcParams));

/** `eth_getLogs` is the one read whose cost the caller chooses: these bound it. */
export const LOGS_BLOCK_RANGE_MAX = 500;
export const LOGS_ADDRESS_MAX = 20;
export const LOGS_TOPIC_ALTERNATIVES_MAX = 20;

const quantity = z.string().check(z.regex(/^0x[0-9a-fA-F]{1,64}$/));
const hash32 = z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/));
const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));
/** Even-length hex calldata; `0x` alone is legal (an empty payload). */
const hexData = z.string().check(z.regex(/^0x([0-9a-fA-F]{2})*$/));
/** The tags that name a recent block; `earliest` would make a range unbounded. */
const recentBlock = z.enum(["latest", "safe", "finalized", "pending"]);
const blockTag = z.enum(["latest", "earliest", "pending", "safe", "finalized"]);
const tagOrNumber = z.union([blockTag, quantity]);

/** A "default block" parameter: tag, quantity, or the EIP-1898 object form. */
const blockParam = z.union([
  tagOrNumber,
  z.strictObject({ blockNumber: quantity }),
  z.strictObject({ blockHash: hash32, requireCanonical: z.optional(z.boolean()) }),
]);

/** Params may be omitted or `[]` for the methods that take none. */
const noParams = z.optional(z.tuple([]));
const optional = <T extends z.ZodMiniType>(inner: T) => z.optional(inner);

/** A transaction call object; `from`/`to` are the only fields the gateway constrains. */
const callTx = z.looseObject({
  from: z.optional(evmAddress),
  to: z.optional(z.union([evmAddress, z.null()])),
});

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

/** The only tags that move with the head; `safe` and `finalized` can trail it by thousands. */
const HEAD_TAGS: ReadonlySet<string> = new Set(["latest", "pending"]);

/**
 * Why an `eth_getLogs` call is refused, or `undefined` when its filter is bounded: one block by
 * hash, a numbered range of at most {@link LOGS_BLOCK_RANGE_MAX} blocks, or tags that name the same
 * block or the head. `safe`/`finalized` may not pair with the head: on Arbitrum that span is
 * thousands of blocks.
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
  const from = filter.fromBlock ?? "latest";
  const to = filter.toBlock ?? "latest";
  if (isNumbered(from) !== isNumbered(to)) {
    return "eth_getLogs needs fromBlock and toBlock to be both block numbers or both block tags";
  }
  if (!isNumbered(from) || !isNumbered(to)) {
    return from === to || (HEAD_TAGS.has(from) && HEAD_TAGS.has(to))
      ? undefined
      : "eth_getLogs block tags must match or both name the head (latest or pending)";
  }
  const span = BigInt(to) - BigInt(from);
  return span < 0n || span >= BigInt(LOGS_BLOCK_RANGE_MAX)
    ? `eth_getLogs is limited to a range of ${LOGS_BLOCK_RANGE_MAX} blocks`
    : undefined;
}

/** The params shape each allow-listed EVM method accepts — one entry per method, no wildcards. */
const EVM_PARAMS: Record<EvmRpcMethod, z.ZodMiniType> = {
  eth_blobBaseFee: noParams,
  eth_blockNumber: noParams,
  eth_call: z.tuple([callTx, optional(blockParam)], z.unknown()),
  eth_chainId: noParams,
  eth_createAccessList: z.tuple([callTx, optional(blockParam)], z.unknown()),
  eth_estimateGas: z.tuple([callTx, optional(blockParam)], z.unknown()),
  eth_feeHistory: z.tuple([
    z.union([quantity, z.int().check(z.nonnegative())]),
    tagOrNumber,
    optional(z.union([z.array(z.number()), z.null()])),
  ]),
  eth_gasPrice: noParams,
  eth_getBalance: z.tuple([evmAddress, optional(blockParam)]),
  eth_getBlockByHash: z.tuple([hash32, z.boolean()]),
  eth_getBlockByNumber: z.tuple([tagOrNumber, z.boolean()]),
  eth_getBlockReceipts: z.tuple([blockParam]),
  eth_getBlockTransactionCountByHash: z.tuple([hash32]),
  eth_getBlockTransactionCountByNumber: z.tuple([tagOrNumber]),
  eth_getCode: z.tuple([evmAddress, optional(blockParam)]),
  eth_getLogs: z
    .array(z.unknown())
    .check(z.refine((params) => logsFilterViolation(params) === undefined)),
  eth_getProof: z.tuple([evmAddress, z.array(z.union([hash32, quantity])), blockParam]),
  eth_getStorageAt: z.tuple([evmAddress, z.union([quantity, hash32]), optional(blockParam)]),
  eth_getTransactionByBlockHashAndIndex: z.tuple([hash32, quantity]),
  eth_getTransactionByBlockNumberAndIndex: z.tuple([tagOrNumber, quantity]),
  eth_getTransactionByHash: z.tuple([hash32]),
  eth_getTransactionCount: z.tuple([evmAddress, optional(blockParam)]),
  eth_getTransactionReceipt: z.tuple([hash32]),
  eth_maxPriorityFeePerGas: noParams,
  eth_sendRawTransaction: z.tuple([hexData]),
  eth_simulateV1: z.tuple([z.looseObject({}), optional(blockParam)]),
  net_version: noParams,
  web3_clientVersion: noParams,
};

const solanaPubkey = z.string().check(z.regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/));
const solanaSignature = z.string().check(z.regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/));
/** Trailing `{ encoding, commitment, … }` config object; its contents pass through. */
const solanaConfig = z.looseObject({});
/** Params `[pubkey]` or `[pubkey, config]`. */
const pubkeyCall = z.tuple([solanaPubkey, optional(solanaConfig)]);
/** Params omitted, `[]` or `[config]`. */
const configOnly = z.optional(z.tuple([z.optional(solanaConfig)]));

const SOLANA_PARAMS: Record<SolanaRpcMethod, z.ZodMiniType> = {
  getAccountInfo: pubkeyCall,
  getBalance: pubkeyCall,
  getBlockHeight: configOnly,
  getBlockTime: z.tuple([z.int().check(z.nonnegative())]),
  getEpochInfo: configOnly,
  getFeeForMessage: z.tuple([z.string().check(z.minLength(1)), optional(solanaConfig)]),
  getGenesisHash: noParams,
  getLatestBlockhash: configOnly,
  getMinimumBalanceForRentExemption: z.tuple([
    z.int().check(z.nonnegative()),
    optional(solanaConfig),
  ]),
  getMultipleAccounts: z.tuple([
    z.array(solanaPubkey).check(z.minLength(1), z.maxLength(100)),
    optional(solanaConfig),
  ]),
  getRecentPrioritizationFees: z.optional(
    z.tuple([z.optional(z.array(solanaPubkey).check(z.maxLength(128)))]),
  ),
  getSignatureStatuses: z.tuple([
    z.array(solanaSignature).check(z.minLength(1), z.maxLength(256)),
    optional(solanaConfig),
  ]),
  getSignaturesForAddress: pubkeyCall,
  getSlot: configOnly,
  getStakeMinimumDelegation: configOnly,
  getTokenAccountBalance: pubkeyCall,
  getTokenAccountsByOwner: z.tuple([
    solanaPubkey,
    z.union([z.strictObject({ mint: solanaPubkey }), z.strictObject({ programId: solanaPubkey })]),
    optional(solanaConfig),
  ]),
  getTokenSupply: pubkeyCall,
  getTransaction: z.tuple([solanaSignature, optional(solanaConfig)]),
  getVersion: noParams,
  getVoteAccounts: configOnly,
  isBlockhashValid: pubkeyCall,
  sendTransaction: z.tuple([z.string().check(z.minLength(1)), optional(solanaConfig)]),
  simulateTransaction: z.tuple([z.string().check(z.minLength(1)), optional(solanaConfig)]),
};

export const evmRpcRequest = bodySchema(
  z.union(EVM_RPC_METHODS.map((method) => callSchema(z.literal(method), EVM_PARAMS[method]))),
);
export const solanaRpcRequest = bodySchema(
  z.union(SOLANA_RPC_METHODS.map((method) => callSchema(z.literal(method), SOLANA_PARAMS[method]))),
);

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

const broadcastMethods: ReadonlySet<string> = new Set(RPC_BROADCAST_METHODS);

/** Whether a validated call or batch relays a signed transaction. */
export function containsBroadcast(body: z.infer<typeof rpcRequest>): boolean {
  const calls = Array.isArray(body) ? body : [body];
  return calls.some((call) => broadcastMethods.has(call.method));
}
