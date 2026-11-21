import type { EvmRpcMethod, SolanaRpcMethod } from "@qntx/wallet-engine/gateway/contract";

/**
 * How a provider account prices its own traffic: `units` in the provider's published metering
 * (Alchemy compute units, dRPC compute units, or one credit per HTTP call), `source` the page the
 * number comes from. Metering every upstream call by these rows is what makes one client's share of
 * a shared API key bounded in the units the provider actually bills.
 */
export type CostRow = { readonly units: number; readonly source: string };

export type CostModel =
  | {
      readonly kind: "rpc";
      readonly methods: Readonly<Record<EvmRpcMethod | SolanaRpcMethod, CostRow>>;
      readonly transfers?: CostRow;
    }
  | { readonly kind: "request"; readonly request: CostRow };

/** The wire shape of a validated call or batch (params are already schema-checked upstream). */
export type RpcCall = { readonly method: string; readonly params?: unknown };

const callsOf = (body: RpcCall | ReadonlyArray<RpcCall>): ReadonlyArray<RpcCall> =>
  "method" in body ? [body] : body;

/**
 * The account units one validated call or batch costs: the sum of each call's method row on an RPC
 * model, or one request credit per batch entry on a request-priced provider (conservative — the
 * provider counts the HTTP calls it sees, and a batch is one).
 */
export function rpcCost(model: CostModel, body: RpcCall | ReadonlyArray<RpcCall>): number {
  const calls = callsOf(body);
  if (model.kind === "request") {
    return calls.length * model.request.units;
  }
  // Allow-listed methods are all keys of `methods`; a non-key is a zero-cost gap, never billed.
  const methods: Readonly<Record<string, CostRow>> = model.methods;
  let total = 0;
  for (const call of calls) {
    total += methods[call.method]?.units ?? 0;
  }
  return total;
}

/** The account units one non-RPC HTTP call costs. Only request-priced providers support it. */
export function requestCost(model: CostModel): number {
  if (model.kind !== "request") {
    throw new Error("requestCost on an rpc-priced account — the provider is misconfigured");
  }
  return model.request.units;
}

/**
 * The account units one probe call costs: its method row where the model prices it, else the
 * fallback — unlisted methods (e.g. Solana's getHealth, billed 20 CU on Alchemy's page) are never
 * free to send. Request-priced providers pay one credit like any other call.
 */
export function probeCost(model: CostModel, method: string): number {
  if (model.kind === "request") {
    return model.request.units;
  }
  const methods: Readonly<Record<string, CostRow>> = model.methods;
  return methods[method]?.units ?? 20;
}

/** The account units one `alchemy_getAssetTransfers` call costs. */
export function transfersCost(model: CostModel): number {
  if (model.kind !== "rpc" || model.transfers === undefined) {
    throw new Error("transfersCost on an account without a transfers row");
  }
  return model.transfers.units;
}

const alchemy = (units: number): CostRow => ({
  units,
  source: "https://www.alchemy.com/docs/reference/compute-unit-costs",
});
const drpc = (units: number): CostRow => ({
  units,
  source: "https://drpc.org/docs/pricing/compute-units",
});

/**
 * Alchemy's throughput compute units (= CU where the page lists no throughput column). Covers every
 * allow-listed EVM and Solana method plus `alchemy_getAssetTransfers`.
 */
export const ALCHEMY_COSTS: CostModel = {
  kind: "rpc",
  methods: {
    eth_blobBaseFee: alchemy(10),
    eth_blockNumber: alchemy(10),
    eth_call: alchemy(26),
    eth_chainId: alchemy(5),
    eth_createAccessList: alchemy(10),
    eth_estimateGas: alchemy(20),
    eth_feeHistory: alchemy(10),
    eth_gasPrice: alchemy(20),
    eth_getBalance: alchemy(20),
    eth_getBlockByHash: alchemy(20),
    eth_getBlockByNumber: alchemy(20),
    eth_getBlockReceipts: alchemy(500),
    eth_getBlockTransactionCountByHash: alchemy(20),
    eth_getBlockTransactionCountByNumber: alchemy(20),
    eth_getCode: alchemy(20),
    eth_getLogs: alchemy(60),
    eth_getProof: alchemy(20),
    eth_getStorageAt: alchemy(20),
    eth_getTransactionByBlockHashAndIndex: alchemy(20),
    eth_getTransactionByBlockNumberAndIndex: alchemy(20),
    eth_getTransactionByHash: alchemy(20),
    eth_getTransactionCount: alchemy(20),
    eth_getTransactionReceipt: alchemy(20),
    eth_maxPriorityFeePerGas: alchemy(10),
    eth_sendRawTransaction: alchemy(50),
    eth_simulateV1: alchemy(40),
    net_version: alchemy(5),
    web3_clientVersion: alchemy(20),
    getAccountInfo: alchemy(10),
    getBalance: alchemy(10),
    getBlockHeight: alchemy(20),
    getBlockTime: alchemy(20),
    getEpochInfo: alchemy(20),
    getFeeForMessage: alchemy(20),
    getGenesisHash: alchemy(10),
    getLatestBlockhash: alchemy(20),
    getMinimumBalanceForRentExemption: alchemy(10),
    getMultipleAccounts: alchemy(20),
    getRecentPrioritizationFees: alchemy(10),
    getSignatureStatuses: alchemy(20),
    getSignaturesForAddress: alchemy(40),
    getSlot: alchemy(20),
    getStakeMinimumDelegation: alchemy(20),
    getTokenAccountBalance: alchemy(20),
    getTokenAccountsByOwner: alchemy(10),
    getTokenSupply: alchemy(20),
    getTransaction: alchemy(40),
    getVersion: alchemy(20),
    getVoteAccounts: alchemy(20),
    isBlockhashValid: alchemy(20),
    sendTransaction: alchemy(20),
    simulateTransaction: alchemy(20),
  },
  transfers: { units: 120, source: "https://www.alchemy.com/docs/reference/compute-unit-costs" },
};

/**
 * DRPC prices every method at a flat 20 compute units, with the chain-identity reads free
 * (https://drpc.org/docs/pricing/compute-units: "All RPC methods cost a flat 20 compute units").
 */
export const DRPC_COSTS: CostModel = {
  kind: "rpc",
  methods: {
    eth_blobBaseFee: drpc(20),
    eth_blockNumber: drpc(20),
    eth_call: drpc(20),
    eth_chainId: drpc(0),
    eth_createAccessList: drpc(20),
    eth_estimateGas: drpc(20),
    eth_feeHistory: drpc(20),
    eth_gasPrice: drpc(20),
    eth_getBalance: drpc(20),
    eth_getBlockByHash: drpc(20),
    eth_getBlockByNumber: drpc(20),
    eth_getBlockReceipts: drpc(20),
    eth_getBlockTransactionCountByHash: drpc(20),
    eth_getBlockTransactionCountByNumber: drpc(20),
    eth_getCode: drpc(20),
    eth_getLogs: drpc(20),
    eth_getProof: drpc(20),
    eth_getStorageAt: drpc(20),
    eth_getTransactionByBlockHashAndIndex: drpc(20),
    eth_getTransactionByBlockNumberAndIndex: drpc(20),
    eth_getTransactionByHash: drpc(20),
    eth_getTransactionCount: drpc(20),
    eth_getTransactionReceipt: drpc(20),
    eth_maxPriorityFeePerGas: drpc(20),
    eth_sendRawTransaction: drpc(20),
    eth_simulateV1: drpc(20),
    net_version: drpc(0),
    web3_clientVersion: drpc(0),
    getAccountInfo: drpc(20),
    getBalance: drpc(20),
    getBlockHeight: drpc(20),
    getBlockTime: drpc(20),
    getEpochInfo: drpc(20),
    getFeeForMessage: drpc(20),
    getGenesisHash: drpc(20),
    getLatestBlockhash: drpc(20),
    getMinimumBalanceForRentExemption: drpc(20),
    getMultipleAccounts: drpc(20),
    getRecentPrioritizationFees: drpc(20),
    getSignatureStatuses: drpc(20),
    getSignaturesForAddress: drpc(20),
    getSlot: drpc(20),
    getStakeMinimumDelegation: drpc(20),
    getTokenAccountBalance: drpc(20),
    getTokenAccountsByOwner: drpc(20),
    getTokenSupply: drpc(20),
    getTransaction: drpc(20),
    getVersion: drpc(20),
    getVoteAccounts: drpc(20),
    isBlockhashValid: drpc(20),
    sendTransaction: drpc(20),
    simulateTransaction: drpc(20),
  },
};
