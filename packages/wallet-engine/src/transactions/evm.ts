/** EVM route: native/ERC-20 send build → fee → decode → sign → broadcast, plus status poll. */
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseTransaction,
} from "viem";
import { readContract } from "viem/actions";

import { ChainError } from "@qntx/wallet-chains";
import type { IntentWarning, SignRequest } from "@qntx/wallet-chains";
import {
  ALLOWANCE_HOLDER,
  EVM_DELEGATOR,
  MAX_UINT256,
  EVM_DELEGATION_PREFIX,
  EVM_NATIVE_ASSET,
  checksumEvmAddress,
  decodeEvm,
  encodeBatchExecute,
  networkChainId,
  LIDO_QUEUE,
  LIDO_STETH,
  ACROSS_SPOKEPOOLS,
  ACROSS_WRAPPED_NATIVE,
} from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { ERC20_ABI, EvmChainAdapter, checkedHex, evmRpcHex } from "../chains/evm.ts";
import type { EvmUnsignedTransaction } from "../chains/evm.ts";
import { LIDO_CHUNK_MAX, LIDO_CHUNK_MIN, LIDO_QUEUE_ABI, LIDO_STETH_ABI } from "../lido/index.ts";
import { resolveEns } from "../names/ens.ts";
import {
  collectChecks,
  exceedsNetworkCap,
  feesDiffer,
  feeReachesAmount,
  mergeEvmQuote,
} from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import { assertBridgeSimulation } from "../swaps/bridge.ts";
import {
  ALLOWANCE_HOLDER_CODE_HASH,
  QUOTE_MAX_AGE_MS,
  SETTLER_FEATURE,
  SETTLER_REGISTRY_ABI,
  ZEROX_REGISTRY,
  assertSwapIntent,
  assertSwapSimulation,
} from "../swaps/index.ts";
import {
  accountAddressOf,
  errorMessage,
  EVM_BATCH_LIMIT,
  newId,
  replacementStaleReason,
} from "./route.ts";
import type {
  ChainApis,
  ChainRequestInput,
  DelegationStatus,
  DisplayIntent,
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  SignParams,
  SignResult,
  TrackedTransaction,
  TxState,
} from "./route.ts";

/** Consecutive polls that must see the nonce mined without our receipt before the tx is settled. */
export const DROP_CONFIRMATIONS = 3;
export const RESUBMIT_BASE_MS = 15_000;
export const RESUBMIT_MAX_MS = 600_000;
/** How long a transaction may stay unknown to the node before it is given up as dropped. */
export const UNKNOWN_DROP_MS = 1_800_000;

type Watch = {
  consumed: number;
  attempt: number;
  unknownSince: number | undefined;
  nextResubmit: number | undefined;
};

const bump = (v: bigint): bigint => (v * 11n + 9n) / 10n;

export type EvmInternalInput = Extract<
  ChainRequestInput,
  {
    readonly method:
      | "evm-delegation"
      | "evm-batch"
      | "evm-approve"
      | "evm-swap"
      | "evm-bridge"
      | "evm-nft-send"
      | "evm-lido";
  }
>;

export type EvmRoute = {
  readonly prepare: (ctx: RouteContext, params: PrepareParams) => Promise<PreparedRequest>;
  /** The account's 7702 delegation state; `supported` follows the registry. */
  readonly delegationState: (
    ctx: RouteContext,
    network: string,
    from: string,
  ) => Promise<DelegationStatus>;
  readonly prepareEvmInternal: (
    ctx: RouteContext,
    input: EvmInternalInput,
  ) => Promise<PreparedRequest>;
  readonly prepareCall: (
    ctx: RouteContext,
    request: {
      readonly account: PrepareParams["account"];
      readonly network: string;
      readonly tx: {
        readonly to?: string;
        readonly value: string;
        readonly data: string;
        readonly gas: string;
      };
    },
  ) => Promise<PreparedRequest>;
  readonly poll: (ctx: RouteContext, tx: TrackedTransaction) => Promise<TxState | undefined>;
  readonly prepareReplace: (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
  ) => Promise<PreparedRequest>;
};

const signSubmit = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  apis: ChainApis,
  request: SignParams["request"],
  verify: SignParams["verify"],
  account: { readonly from: string; readonly groupIndex: number },
  broadcast: (signed: SignResult) => Promise<{ readonly hash: string; readonly raw: string }>,
): Promise<TrackedTransaction> => {
  let signed: SignResult;
  let tracked = tx;
  try {
    const result = await apis.sign({ request, verify });
    tracked = await ctx.transition(tracked, { state: "signed" });
    signed = result;
  } catch (error) {
    await ctx.transition(tracked, { state: "rejected", error: errorMessage(error) });
    throw error;
  }
  try {
    const { hash, raw } = await broadcast(signed);
    tracked = await ctx.transition(tracked, {
      state: "submitted",
      hash,
      evm: { from: account.from, groupIndex: account.groupIndex, raw },
      submittedAt: ctx.options.now(),
    });
    ctx.track(tracked.id, hash);
    return tracked;
  } catch (error) {
    await ctx.transition(tracked, { state: "failed", error: errorMessage(error) });
    throw error;
  }
};

/** The unsigned transaction a persisted signed `raw` was built from. */
const rebuild = (
  old: TrackedTransaction,
  from: string,
  raw: string,
  chainId: number,
): EvmUnsignedTransaction => {
  if (!isHex(raw)) {
    throw new Error("build record is malformed");
  }
  const parsed = parseTransaction(raw);
  if (parsed.chainId !== chainId) {
    throw new Error("build record is for a different chain");
  }
  if (parsed.nonce !== old.nonce) {
    throw new Error("build record nonce does not match the transaction");
  }
  if (parsed.to === undefined || parsed.to === null || parsed.gas === undefined) {
    throw new Error("build record is incomplete");
  }
  const list = parsed.authorizationList;
  if (list !== undefined && list.length > 1) {
    throw new Error("build record authorization is unexpected");
  }
  let authorization: { readonly address: string } | undefined;
  const auth = list?.[0];
  if (auth !== undefined) {
    const address = checksumEvmAddress(auth.address);
    if (
      (address !== EVM_DELEGATOR.address &&
        address !== "0x0000000000000000000000000000000000000000") ||
      BigInt(auth.nonce) !== BigInt(parsed.nonce + 1)
    ) {
      throw new Error("build record authorization is unexpected");
    }
    authorization = { address };
  }
  return {
    family: "evm",
    network: old.network,
    from,
    to: checksumEvmAddress(parsed.to),
    value: parsed.value ?? 0n,
    data: parsed.data ?? "0x",
    nonce: parsed.nonce,
    gas: parsed.gas,
    ...("gasPrice" in parsed && parsed.gasPrice !== undefined ? { gasPrice: parsed.gasPrice } : {}),
    ...("maxFeePerGas" in parsed && parsed.maxFeePerGas !== undefined
      ? { maxFeePerGas: parsed.maxFeePerGas }
      : {}),
    ...("maxPriorityFeePerGas" in parsed && parsed.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: parsed.maxPriorityFeePerGas }
      : {}),
    ...(authorization === undefined ? {} : { authorization }),
  };
};

/** Other tracked transactions with a hash at the same (network, sender, nonce). */
const sameNonce = (ctx: RouteContext, tx: TrackedTransaction, from: string): TrackedTransaction[] =>
  Object.values(ctx.txs()).filter(
    (t) =>
      t.id !== tx.id &&
      t.family === "evm" &&
      t.network === tx.network &&
      t.nonce === tx.nonce &&
      t.hash !== undefined &&
      t.evm?.from.toLowerCase() === from.toLowerCase(),
  );

const evmApis = (ctx: RouteContext): ChainApis => ctx.options.chains ?? chains(ctx.options.wallet);

/** The signer's EVM address for an HD account; throws when the account is imported or has none. */
const resolveFrom = async (
  ctx: RouteContext,
  account: PrepareParams["account"],
  network: string,
): Promise<string> => {
  return accountAddressOf(ctx, account, "evm.bip44", network);
};

const withL1Fee = (intent: DisplayIntent, l1: bigint | undefined): DisplayIntent =>
  l1 === undefined || intent.fee === undefined
    ? intent
    : {
        ...intent,
        fee: { ...intent.fee, l1Data: { asset: EVM_NATIVE_ASSET, amount: l1.toString(10) } },
      };

const erc20Allowance = async (
  client: Parameters<typeof readContract>[0],
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> =>
  readContract(client, {
    address: getAddress(token),
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [getAddress(owner), getAddress(spender)],
  });

/** `allowance(owner, spender)` on both endpoints; the lower wins, a disagreement is flagged. */
const readAllowance = async (
  ctx: RouteContext,
  network: string,
  token: string,
  owner: string,
  spender: string,
  flags: Array<RequestCheckCode | undefined>,
): Promise<bigint> => {
  const client = ctx.options.networks.client(network);
  const primary = await erc20Allowance(client, token, owner, spender);
  const independent = ctx.options.networks.independentClient(network);
  if (independent.kind === "available") {
    try {
      const other = await erc20Allowance(independent.client, token, owner, spender);
      if (primary !== other) {
        flags.push("reads-unverified");
      }
      return primary < other ? primary : other;
    } catch {
      flags.push("reads-unverified");
    }
  }
  return primary;
};

type BuildIntent = Parameters<EvmChainAdapter["build"]>[3];

type ViemClient = Parameters<typeof readContract>[0];

const LIDO_ZERO = "0x0000000000000000000000000000000000000000";

const lidoJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown): unknown => (typeof x === "bigint" ? x.toString() : x));
const sameRead = (a: unknown, b: unknown): boolean => lidoJson(a) === lidoJson(b);

/**
 * A Lido read cross-checked on the independent endpoint: a successful disagreeing read refuses, a
 * failed independent read degrades to `reads-unverified` — same rule as the swap path.
 */
const lidoRead = async <T>(
  ctx: RouteContext,
  network: string,
  flags: Array<RequestCheckCode | undefined>,
  mismatch: string,
  read: (client: ViemClient) => Promise<T>,
): Promise<T> => {
  const client = ctx.options.networks.client(network);
  const independent = ctx.options.networks.independentClient(network);
  const primary = await read(client);
  if (independent.kind === "available") {
    try {
      const other = await read(independent.client);
      if (!sameRead(primary, other)) {
        throw new ChainError("invalid-request", mismatch);
      }
    } catch (error) {
      if (error instanceof ChainError) {
        throw error;
      }
      flags.push("reads-unverified");
    }
  }
  return primary;
};

const queuePaused = async (
  ctx: RouteContext,
  network: string,
  flags: Array<RequestCheckCode | undefined>,
): Promise<void> => {
  const paused = await lidoRead(
    ctx,
    network,
    flags,
    "the queue's pause state differs between endpoints",
    async (c) =>
      readContract(c, {
        address: LIDO_QUEUE,
        abi: LIDO_QUEUE_ABI,
        functionName: "isPaused",
      }),
  );
  if (paused) {
    throw new ChainError("invalid-request", "the Lido withdrawal queue is paused");
  }
};

/** `amount` split into request chunks of ≤ 1000 ETH, every chunk ≥ 100 wei — refuses if impossible. */
const lidoChunks = (amount: bigint): ReadonlyArray<bigint> => {
  if (amount < LIDO_CHUNK_MIN) {
    throw new ChainError(
      "invalid-request",
      `a withdrawal request needs at least ${LIDO_CHUNK_MIN} wei`,
    );
  }
  const count = amount / LIDO_CHUNK_MAX + (amount % LIDO_CHUNK_MAX === 0n ? 0n : 1n);
  const chunks: bigint[] = [];
  let rest = amount;
  for (let i = 0n; i < count; i++) {
    const take = rest > LIDO_CHUNK_MAX ? LIDO_CHUNK_MAX : rest;
    chunks.push(take);
    rest -= take;
  }
  const last = chunks.at(-1);
  if (last !== undefined && last < LIDO_CHUNK_MIN && chunks.length > 1) {
    /* Rebalance: a lone sub-minimum tail borrows from the previous full chunk. */
    const prev = chunks.at(-2);
    if (prev !== undefined) {
      const borrow = LIDO_CHUNK_MIN - last;
      chunks[chunks.length - 2] = prev - borrow;
      chunks[chunks.length - 1] = last + borrow;
    }
  }
  return chunks;
};

/** The built request must decode to `stake` with exactly the expected Lido action (builder guard). */
const lidoApproveCall = (amount: bigint): { to: string; value: bigint; data: string } => ({
  to: LIDO_STETH,
  value: 0n,
  data: encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [LIDO_QUEUE, amount],
  }),
});

const assertLidoIntent = (
  action: Extract<ChainRequestInput, { method: "evm-lido" }>["action"],
  intent: ReturnType<typeof decodeEvm>,
): void => {
  const kind =
    action.kind === "stake"
      ? "lido-submit"
      : action.kind === "request"
        ? "lido-request"
        : "lido-claim";
  const staking = intent.staking ?? [];
  if (staking.length !== 1 || staking[0]?.kind !== kind) {
    throw new ChainError(
      "invalid-request",
      "the built transaction does not decode to the expected Lido action",
    );
  }
};

const prepareLidoIntent = async (
  ctx: RouteContext,
  input: Extract<ChainRequestInput, { method: "evm-lido" }>,
  from: string,
  flags: Array<RequestCheckCode | undefined>,
  stateOf: () => Promise<Awaited<ReturnType<EvmChainAdapter["delegation"]>>>,
): Promise<BuildIntent> => {
  const { action, network } = input;
  if (network !== "eip155:1") {
    throw new ChainError("invalid-request", "Lido staking is Ethereum mainnet only");
  }
  const read = async <T>(mismatch: string, fn: (client: ViemClient) => Promise<T>) =>
    lidoRead(ctx, network, flags, mismatch, fn);

  if (action.kind === "stake") {
    if (action.amount <= 0n) {
      throw new ChainError("invalid-request", "the stake amount must be positive");
    }
    const paused = await read("the staking pause state differs between endpoints", async (c) =>
      readContract(c, {
        address: LIDO_STETH,
        abi: LIDO_STETH_ABI,
        functionName: "isStakingPaused",
      }),
    );
    if (paused) {
      throw new ChainError("invalid-request", "Lido staking is paused");
    }
    const limit = await read("the stake limit differs between endpoints", async (c) =>
      readContract(c, {
        address: LIDO_STETH,
        abi: LIDO_STETH_ABI,
        functionName: "getCurrentStakeLimit",
      }),
    );
    if (action.amount > limit) {
      throw new ChainError(
        "invalid-request",
        `the stake exceeds the current limit of ${limit} wei`,
      );
    }
    return {
      kind: "call",
      to: LIDO_STETH,
      value: action.amount,
      data: encodeFunctionData({
        abi: LIDO_STETH_ABI,
        functionName: "submit",
        args: [LIDO_ZERO],
      }),
    };
  }

  if (action.kind === "request") {
    const chunks = lidoChunks(action.amount);
    await queuePaused(ctx, network, flags);
    const owner = getAddress(from);
    const data = encodeFunctionData({
      abi: LIDO_QUEUE_ABI,
      functionName: "requestWithdrawals",
      args: [chunks, owner],
    });
    const allowance = await readAllowance(ctx, network, LIDO_STETH, from, LIDO_QUEUE, flags);
    if (allowance >= action.amount) {
      return { kind: "call", to: LIDO_QUEUE, value: 0n, data };
    }
    const state = await stateOf();
    if (state.kind !== "ours") {
      throw new ChainError("invalid-request", "approve the withdrawal queue for the amount first");
    }
    const calls = [
      ...(allowance === 0n ? [] : [lidoApproveCall(0n)]),
      lidoApproveCall(action.amount),
      { to: LIDO_QUEUE, value: 0n, data },
    ];
    return {
      kind: "call",
      to: from,
      value: 0n,
      data: encodeBatchExecute(
        calls.map((c) => ({ to: checksumEvmAddress(c.to), value: c.value, data: c.data })),
      ),
    };
  }

  const ids = [...new Set(action.requestIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ids.length === 0) {
    throw new ChainError("invalid-request", "no withdrawal requests to claim");
  }
  await queuePaused(ctx, network, flags);
  const status = await read("the withdrawal status differs between endpoints", async (c) =>
    readContract(c, {
      address: LIDO_QUEUE,
      abi: LIDO_QUEUE_ABI,
      functionName: "getWithdrawalStatus",
      args: [ids],
    }),
  );
  for (const [i, entry] of status.entries()) {
    if (entry.owner.toLowerCase() !== from.toLowerCase()) {
      throw new ChainError(
        "invalid-request",
        `withdrawal request ${String(ids[i])} does not belong to this account`,
      );
    }
    if (!entry.isFinalized) {
      throw new ChainError(
        "invalid-request",
        `withdrawal request ${String(ids[i])} is not finalised`,
      );
    }
    if (entry.isClaimed) {
      throw new ChainError(
        "invalid-request",
        `withdrawal request ${String(ids[i])} is already claimed`,
      );
    }
  }
  const last = await read("the last checkpoint differs between endpoints", async (c) =>
    readContract(c, {
      address: LIDO_QUEUE,
      abi: LIDO_QUEUE_ABI,
      functionName: "getLastCheckpointIndex",
    }),
  );
  const hints = await read("the checkpoint hints differ between endpoints", async (c) =>
    readContract(c, {
      address: LIDO_QUEUE,
      abi: LIDO_QUEUE_ABI,
      functionName: "findCheckpointHints",
      args: [ids, 1n, last],
    }),
  );
  return {
    kind: "call",
    to: LIDO_QUEUE,
    value: 0n,
    data: encodeFunctionData({
      abi: LIDO_QUEUE_ABI,
      functionName: "claimWithdrawals",
      args: [ids, hints],
    }),
  };
};

const ACROSS_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "depositor", type: "bytes32" },
      { name: "recipient", type: "bytes32" },
      { name: "inputToken", type: "bytes32" },
      { name: "outputToken", type: "bytes32" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputAmount", type: "uint256" },
      { name: "destinationChainId", type: "uint256" },
      { name: "exclusiveRelayer", type: "bytes32" },
      { name: "quoteTimestamp", type: "uint32" },
      { name: "fillDeadline", type: "uint32" },
      { name: "exclusivityParameter", type: "uint32" },
      { name: "message", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const pad32 = (address: string): `0x${string}` => `0x${address.slice(2).padStart(64, "0")}`;

/** The SpokePool `deposit` calldata built from a verified quote — the SDK data suffix is not used. */
const acrossDepositCall = (
  depositor: string,
  quote: {
    readonly inputToken: string;
    readonly outputToken: string;
    readonly inputAmount: bigint;
    readonly outputAmount: bigint;
    readonly exclusiveRelayer: string;
    readonly quoteTimestamp: number;
    readonly fillDeadline: number;
    readonly exclusivityParameter: number;
  },
  destinationChainId: number,
): string =>
  encodeFunctionData({
    abi: ACROSS_DEPOSIT_ABI,
    functionName: "deposit",
    args: [
      pad32(depositor),
      pad32(depositor),
      pad32(quote.inputToken),
      pad32(quote.outputToken),
      quote.inputAmount,
      quote.outputAmount,
      BigInt(destinationChainId),
      pad32(quote.exclusiveRelayer),
      quote.quoteTimestamp,
      quote.fillDeadline,
      quote.exclusivityParameter,
      "0x",
    ],
  });

/** `approve(ALLOWANCE_HOLDER, amount)` calldata for a delegated swap batch. */
const allowanceHolderApprove = (amount: bigint): string =>
  encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [getAddress(ALLOWANCE_HOLDER), amount],
  });

/** The registry's current (`ownerOf`) and previous (`prev`) Settler for a feature. */
const registrySettlers = async (
  client: Parameters<typeof readContract>[0],
): Promise<{ readonly current: string; readonly previous: string | undefined }> => {
  let current: string;
  try {
    current = await readContract(client, {
      address: ZEROX_REGISTRY,
      abi: SETTLER_REGISTRY_ABI,
      functionName: "ownerOf",
      args: [SETTLER_FEATURE],
    });
  } catch {
    throw new ChainError("invalid-request", "0x Settler is paused");
  }
  let previous: string | undefined;
  try {
    previous = await readContract(client, {
      address: ZEROX_REGISTRY,
      abi: SETTLER_REGISTRY_ABI,
      functionName: "prev",
      args: [SETTLER_FEATURE],
    });
  } catch {
    /* `prev` reverts when the feature has never been redeployed — that is not a pause. */
  }
  return { current, previous };
};

/* approve(spender, amount) — refuses an unlimited amount and the USDT-style nonzero reset. */
const prepareApproveIntent = async (
  ctx: RouteContext,
  input: Extract<ChainRequestInput, { method: "evm-approve" }>,
  from: string,
  flags: Array<RequestCheckCode | undefined>,
): Promise<BuildIntent> => {
  if (input.amount === MAX_UINT256) {
    throw new ChainError("invalid-request", "an unlimited approval is refused");
  }
  const current = await readAllowance(ctx, input.network, input.token, from, input.spender, flags);
  if (current === input.amount) {
    throw new ChainError("invalid-request", "the allowance is already the requested amount");
  }
  if (current !== 0n && input.amount !== 0n) {
    throw new ChainError(
      "invalid-request",
      "reset the allowance to zero first — the token rejects a nonzero overwrite",
    );
  }
  return {
    kind: "call",
    to: input.token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [getAddress(input.spender), input.amount],
    }),
  };
};

/* The built call must decode back to exactly the send: one NFT outflow to the recipient
   with the right contract, id and unit count — like the bridge's quote-term guard. */
const guardNftCall = (
  input: Extract<ChainRequestInput, { method: "evm-nft-send" }>,
  from: string,
  to: string,
  tokenId: bigint,
  amount: bigint,
  data: string,
): BuildIntent => {
  const request: SignRequest = {
    kind: "evm.transaction",
    network: input.network,
    account: input.account,
    tx: {
      type: "eip1559",
      chainId: networkChainId(input.network),
      to: input.contract,
      value: "0x0",
      nonce: 0,
      gas: "0x0",
      data,
      accessList: [],
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0",
    },
  };
  const intent = decodeEvm(request, from);
  const [outflow] = intent.outflows;
  if (
    intent.summary !== "transfer" ||
    intent.outflows.length !== 1 ||
    outflow === undefined ||
    outflow.to.toLowerCase() !== to.toLowerCase() ||
    outflow.amount.asset.toLowerCase() !== input.contract.toLowerCase() ||
    outflow.amount.tokenId !== tokenId.toString(10) ||
    outflow.amount.amount !== amount.toString(10)
  ) {
    throw new ChainError("invalid-request", "the built transfer does not decode to the send");
  }
  return { kind: "call", to: input.contract, value: 0n, data };
};

/* A cross-checked read on both endpoints: a successful disagreeing read refuses, a failed
   independent read degrades to `reads-unverified` — same rule as the swap path. */
const nftRead = async <T>(
  ctx: RouteContext,
  network: string,
  read: (client: ViemClient) => Promise<T>,
  flags: Array<RequestCheckCode | undefined>,
): Promise<T> => {
  const primary = await read(ctx.options.networks.client(network));
  const independent = ctx.options.networks.independentClient(network);
  if (independent.kind === "available") {
    try {
      const other = await read(independent.client);
      if (other !== primary) {
        throw new ChainError("invalid-request", "the two endpoints disagree on the NFT read");
      }
    } catch (error) {
      if (error instanceof ChainError) {
        throw error;
      }
      flags.push("reads-unverified");
    }
  }
  return primary;
};

/** Per-controller route — the adapter's nonce queue and the per-tx poll state are engine state. */
export const createEvmRoute = (): EvmRoute => {
  const evm = new EvmChainAdapter();
  const watching = new Map<string, Watch>();

  type PrepareSpec = {
    readonly account: PrepareParams["account"];
    readonly network: string;
    /** The resolved signer address; each path looks the account up exactly once. */
    readonly from: string;
    readonly intent: BuildIntent;
    readonly fee: PrepareParams["fee"];
    /** Native value moved; the worst-case fee reaching it is flagged. */
    readonly nativeValue: bigint | undefined;
  };

  /**
   * OP Stack L1 data fee plus operator fee for `tx`, the larger of the primary and independent
   * reads (the chain charges it either way; the figure only drives display and checks). Unknown
   * when the primary read fails.
   */
  const opStackFee = async (
    ctx: RouteContext,
    network: string,
    tx: EvmUnsignedTransaction,
    flags: Array<RequestCheckCode | undefined>,
  ): Promise<bigint | undefined> => {
    const { networks } = ctx.options;
    let fee: bigint;
    try {
      fee = await evm.opStackFee(networks.client(network), tx);
    } catch {
      flags.push("reads-unverified");
      return undefined;
    }
    const independent = networks.independentClient(network);
    if (independent.kind === "available") {
      try {
        const other = await evm.opStackFee(independent.client, tx);
        flags.push(feesDiffer(fee, other) ? "fee-mismatch" : undefined);
        fee = other > fee ? other : fee;
      } catch {
        flags.push("reads-unverified");
      }
    }
    return fee;
  };

  const prepareSpec = async (ctx: RouteContext, spec: PrepareSpec): Promise<PreparedRequest> => {
    const { account, network, fee, from } = spec;
    const { networks } = ctx.options;
    const info = networks.info(network);
    const client = networks.client(network);
    const independent = networks.independentClient(network);
    const apis = evmApis(ctx);
    const flags: Array<RequestCheckCode | undefined> = [
      independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ];

    let nonce = await evm.nextNonce(client, network, from);
    if (independent.kind === "available") {
      try {
        const [primary, other] = await Promise.all([
          evm.pendingCount(client, from),
          evm.pendingCount(independent.client, from),
        ]);
        nonce = Math.max(nonce, other);
        flags.push(primary === other ? undefined : "nonce-mismatch");
      } catch {
        flags.push("reads-unverified");
      }
    }
    const unsigned = await evm.build(client, network, from, spec.intent, nonce);
    const quotes = await evm.estimateFee(client);
    let quote = quotes.find((q) => q.tier === fee) ?? quotes[1];
    if (quote === undefined) {
      throw new Error("no fee quote");
    }
    if (independent.kind === "available") {
      try {
        const others = await evm.estimateFee(independent.client);
        const other = others.find((q) => q.tier === quote?.tier);
        if (other === undefined) {
          flags.push("reads-unverified");
        } else {
          const merged = mergeEvmQuote(quote, other);
          ({ quote } = merged);
          flags.push(
            merged.mismatch ? "fee-mismatch" : undefined,
            exceedsNetworkCap(quote.maxFeePerGas, other.maxFeePerGas)
              ? "fee-above-network"
              : undefined,
          );
        }
      } catch {
        flags.push("reads-unverified");
      }
    }
    const feed = evm.applyFee(unsigned, quote);
    const l1 = info.opStack === true ? await opStackFee(ctx, network, feed, flags) : undefined;
    if (
      spec.nativeValue !== undefined &&
      feeReachesAmount(
        feed.gas * (feed.maxFeePerGas ?? feed.gasPrice ?? 0n) + (l1 ?? 0n),
        spec.nativeValue,
      )
    ) {
      flags.push("fee-exceeds-amount");
    }
    const request = evm.toSignRequest(feed, account, info.chainId);
    const intent = withL1Fee(decodeEvm(request, from), l1);
    const txId = newId(ctx.options.random);
    const simulated = { to: feed.to, value: feed.value, data: feed.data };
    const delegatedCode =
      feed.authorization?.address === EVM_DELEGATOR.address
        ? `${EVM_DELEGATION_PREFIX}${EVM_DELEGATOR.address.slice(2)}`
        : undefined;
    const simulation = await evm.simulate(
      client,
      info.chainId,
      from,
      simulated,
      ctx.options.setTimer,
      delegatedCode,
    );

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
      let tx: TrackedTransaction = {
        id: txId,
        family: "evm",
        network,
        account: account.kind === "hd" ? account.walletId : account.keyId,
        hash: undefined,
        state: "draft",
        intent,
        nonce: unsigned.nonce,
        submittedAt: ctx.options.now(),
        error: undefined,
      };
      tx = await ctx.transition(tx, {});
      return signSubmit(
        ctx,
        tx,
        apis,
        request,
        verify,
        { from, groupIndex: account.kind === "hd" ? account.groupIndex : -1 },
        async (signed) => {
          const raw = evm.finalize(feed, signed);
          const hash = await evm.broadcast(client, raw);
          evm.commitNonce(network, from, unsigned.nonce);
          return { hash, raw };
        },
      );
    };

    return {
      txId,
      account,
      network,
      intent,
      checks: collectChecks(flags),
      simulation,
      resimulate: async () =>
        evm.simulate(client, info.chainId, from, simulated, ctx.options.setTimer, delegatedCode),
      staleReason: () =>
        evm.nonceConsumed(network, from, unsigned.nonce)
          ? "nonce already used by a newer transaction — start over"
          : undefined,
      submit,
      release: () => undefined,
    };
  };

  /**
   * The shared 7702 precondition: the network supports it, both endpoints agree on the account's
   * delegation state and both endpoints serve a delegator whose runtime code hashes to the registry
   * value. An unavailable independent endpoint degrades to `reads-unverified`.
   */
  const delegationState = async (
    ctx: RouteContext,
    network: string,
    from: string,
    flags: Array<RequestCheckCode | undefined>,
  ): Promise<Awaited<ReturnType<EvmChainAdapter["delegation"]>>> => {
    const { networks } = ctx.options;
    const info = networks.info(network);
    if (info.delegatorCodeHash === undefined) {
      throw new ChainError("unsupported", "network does not support EIP-7702");
    }
    const hash = info.delegatorCodeHash;
    const primary = networks.client(network);
    const independent = networks.independentClient(network);
    const state = await evm.delegation(primary, from);
    if (!(await evm.delegatorVerified(primary, hash))) {
      throw new ChainError("invalid-request", "delegator contract is not what the network expects");
    }
    if (independent.kind === "available") {
      const other = await evm.delegation(independent.client, from);
      const agree =
        state.kind === other.kind &&
        (other.kind !== "other" || state.kind !== "other" || other.address === state.address);
      if (!agree) {
        throw new ChainError("invalid-request", "delegation state differs between endpoints");
      }
      if (!(await evm.delegatorVerified(independent.client, hash))) {
        throw new ChainError(
          "invalid-request",
          "delegator contract is not what the network expects",
        );
      }
    } else {
      flags.push("reads-unverified");
    }
    return state;
  };

  /**
   * The delegation state for the allowance-fallback paths: a network without EIP-7702 cannot run
   * the delegated approve batch, so it reads as "none" and the caller refuses with the existing
   * approve-first message instead of surfacing the 7702 error.
   */
  const delegationStateOrNone = async (
    ctx: RouteContext,
    network: string,
    from: string,
    flags: Array<RequestCheckCode | undefined>,
  ): Promise<Awaited<ReturnType<EvmChainAdapter["delegation"]>>> => {
    if (ctx.options.networks.info(network).delegatorCodeHash === undefined) {
      return { kind: "none" };
    }
    return delegationState(ctx, network, from, flags);
  };

  /* `evm-swap`: verify the quote, then a single exec or a delegated [approve, exec] batch. */
  const prepareSwapIntent = async (
    ctx: RouteContext,
    input: Extract<ChainRequestInput, { method: "evm-swap" }>,
    from: string,
    flags: Array<RequestCheckCode | undefined>,
  ): Promise<BuildIntent> => {
    const { quote } = input;
    if (ctx.options.now() - quote.fetchedAt > QUOTE_MAX_AGE_MS) {
      throw new ChainError("invalid-request", "the quote is stale — re-quote");
    }
    if (quote.network !== input.network || quote.taker.toLowerCase() !== from.toLowerCase()) {
      throw new ChainError("invalid-request", "the quote is not for this account and network");
    }
    const { transaction: tx } = quote;
    if (tx.to.toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase()) {
      throw new ChainError(
        "invalid-request",
        "the quoted transaction does not call AllowanceHolder",
      );
    }
    const client = ctx.options.networks.client(input.network);
    const independent = ctx.options.networks.independentClient(input.network);
    const ahCode = await evmRpcHex(client, "eth_getCode", [ALLOWANCE_HOLDER, "latest"]);
    if (keccak256(checkedHex(ahCode)) !== ALLOWANCE_HOLDER_CODE_HASH) {
      throw new ChainError("invalid-request", "the AllowanceHolder is not the expected contract");
    }
    if (independent.kind === "available") {
      try {
        const other = await evmRpcHex(independent.client, "eth_getCode", [
          ALLOWANCE_HOLDER,
          "latest",
        ]);
        if (keccak256(checkedHex(other)) !== ALLOWANCE_HOLDER_CODE_HASH) {
          throw new ChainError(
            "invalid-request",
            "the AllowanceHolder is not the expected contract",
          );
        }
      } catch (error) {
        if (error instanceof ChainError) {
          throw error;
        }
        flags.push("reads-unverified");
      }
    }
    /* The call must decode to a swap whose sell and minimum the quote claims. */
    const request: SignRequest = {
      kind: "evm.transaction",
      network: input.network,
      account: input.account,
      tx: {
        type: "eip1559",
        chainId: networkChainId(input.network),
        to: tx.to,
        value: `0x${tx.value.toString(16)}`,
        nonce: 0,
        gas: "0x0",
        data: tx.data,
        accessList: [],
        maxFeePerGas: "0x0",
        maxPriorityFeePerGas: "0x0",
      },
    };
    const intent = decodeEvm(request, from);
    assertSwapIntent(quote, intent, from);
    const [outflow] = intent.outflows;
    const settler = outflow?.to ?? "";
    /* The decoded Settler must be the registry's current or previous taker Settler on both
       endpoints; a failed independent read only flags the check unverified. */
    const { current, previous } = await registrySettlers(client);
    if (
      settler.toLowerCase() !== current.toLowerCase() &&
      settler.toLowerCase() !== previous?.toLowerCase()
    ) {
      throw new ChainError("invalid-request", "the swap settles through an unrecognised Settler");
    }
    if (independent.kind === "available") {
      try {
        const other = await registrySettlers(independent.client);
        if (
          settler.toLowerCase() !== other.current.toLowerCase() &&
          settler.toLowerCase() !== other.previous?.toLowerCase()
        ) {
          throw new ChainError(
            "invalid-request",
            "the swap settles through an unrecognised Settler",
          );
        }
      } catch (error) {
        if (error instanceof ChainError) {
          throw error;
        }
        flags.push("reads-unverified");
      }
    }
    const sellNative = quote.sell === EVM_NATIVE_ASSET;
    if (!sellNative) {
      /* ERC-20 sells must not forward value; native sells forward exactly sellAmount. */
      if (tx.value !== 0n) {
        throw new ChainError("invalid-request", "an ERC-20 sell carries no value");
      }
      const current = await readAllowance(
        ctx,
        input.network,
        quote.sell,
        from,
        ALLOWANCE_HOLDER,
        flags,
      );
      if (current >= quote.sellAmount) {
        return { kind: "call", to: tx.to, value: tx.value, data: tx.data };
      }
      const state = await delegationStateOrNone(ctx, input.network, from, flags);
      if (state.kind !== "ours") {
        throw new ChainError(
          "invalid-request",
          "approve AllowanceHolder for the sell amount first, then re-quote",
        );
      }
      const calls = [
        ...(current === 0n
          ? []
          : [{ to: quote.sell, value: 0n, data: allowanceHolderApprove(0n) }]),
        { to: quote.sell, value: 0n, data: allowanceHolderApprove(quote.sellAmount) },
        { to: tx.to, value: tx.value, data: tx.data },
      ];
      return {
        kind: "call",
        to: from,
        value: 0n,
        data: encodeBatchExecute(
          calls.map((c) => ({
            to: checksumEvmAddress(c.to),
            value: c.value,
            data: c.data,
          })),
        ),
      };
    }
    if (tx.value !== quote.sellAmount) {
      throw new ChainError("invalid-request", "a native sell must forward exactly its amount");
    }
    return { kind: "call", to: tx.to, value: tx.value, data: tx.data };
  };

  /* `evm-bridge`: verify the quote, build the SpokePool deposit, gate the ERC-20 allowance. */
  const prepareBridgeIntent = async (
    ctx: RouteContext,
    input: Extract<ChainRequestInput, { method: "evm-bridge" }>,
    from: string,
    flags: Array<RequestCheckCode | undefined>,
  ): Promise<BuildIntent> => {
    const { quote } = input;
    if (ctx.options.now() - quote.fetchedAt > QUOTE_MAX_AGE_MS) {
      throw new ChainError("invalid-request", "the quote is stale — re-quote");
    }
    if (quote.taker.toLowerCase() !== from.toLowerCase()) {
      throw new ChainError("invalid-request", "the quote is not for this account");
    }
    const originChainId = networkChainId(input.network);
    const destinationChainId = networkChainId(quote.destinationNetwork);
    const spokePool = ACROSS_SPOKEPOOLS[originChainId];
    if (spokePool === undefined || ACROSS_SPOKEPOOLS[destinationChainId] === undefined) {
      throw new ChainError("invalid-request", "the network pair does not support Across bridges");
    }
    if (quote.spokePool.toLowerCase() !== spokePool.toLowerCase()) {
      throw new ChainError("invalid-request", "the quote names a different SpokePool");
    }
    /* Across deposits always pay a nonnegative relay fee, so the destination amount of a
       same-asset route can never exceed the input. */
    if (quote.outputAmount <= 0n || quote.outputAmount > quote.inputAmount) {
      throw new ChainError("invalid-request", "the quoted output amount is out of range");
    }
    /* The depositor refunds after fillDeadline; the deadline must be in the future and within the
       protocol's 7200 s fill-deadline buffer of the quote timestamp. */
    if (
      quote.fillDeadline * 1000 <= ctx.options.now() ||
      quote.fillDeadline - quote.quoteTimestamp > 7200
    ) {
      throw new ChainError("invalid-request", "the quoted fill deadline is out of range");
    }
    const native =
      quote.inputToken.toLowerCase() === (ACROSS_WRAPPED_NATIVE[originChainId] ?? "").toLowerCase();
    const data = acrossDepositCall(from, quote, destinationChainId);
    /* The built call must decode back to the quote's exact terms. */
    const request: SignRequest = {
      kind: "evm.transaction",
      network: input.network,
      account: input.account,
      tx: {
        type: "eip1559",
        chainId: originChainId,
        to: spokePool,
        value: `0x${(native ? quote.inputAmount : 0n).toString(16)}`,
        nonce: 0,
        gas: "0x0",
        data,
        accessList: [],
        maxFeePerGas: "0x0",
        maxPriorityFeePerGas: "0x0",
      },
    };
    const intent = decodeEvm(request, from);
    if (
      intent.summary !== "bridge" ||
      intent.minimumReceived?.[0]?.to.toLowerCase() !== from.toLowerCase() ||
      intent.minimumReceived[0].amount.amount !== quote.outputAmount.toString(10) ||
      intent.minimumReceived[0].amount.asset.toLowerCase() !== quote.outputToken.toLowerCase() ||
      intent.bridge?.destinationNetwork !== quote.destinationNetwork ||
      intent.bridge.fillDeadline !== quote.fillDeadline ||
      intent.bridge.refundTo.toLowerCase() !== from.toLowerCase()
    ) {
      throw new ChainError("invalid-request", "the built deposit does not decode to the quote");
    }
    const [outflow] = intent.outflows;
    if (
      outflow === undefined ||
      (native
        ? outflow.amount.asset !== EVM_NATIVE_ASSET ||
          outflow.amount.amount !== quote.inputAmount.toString(10)
        : outflow.amount.asset.toLowerCase() !== quote.inputToken.toLowerCase() ||
          outflow.amount.amount !== quote.inputAmount.toString(10))
    ) {
      throw new ChainError("invalid-request", "the built deposit does not decode to the quote");
    }
    if (native) {
      return { kind: "call", to: spokePool, value: quote.inputAmount, data };
    }
    const current = await readAllowance(
      ctx,
      input.network,
      quote.inputToken,
      from,
      spokePool,
      flags,
    );
    if (current >= quote.inputAmount) {
      return { kind: "call", to: spokePool, value: 0n, data };
    }
    const state = await delegationStateOrNone(ctx, input.network, from, flags);
    if (state.kind !== "ours") {
      throw new ChainError(
        "invalid-request",
        "approve the SpokePool for the input amount first, then re-quote",
      );
    }
    const calls = [
      ...(current === 0n
        ? []
        : [{ to: quote.inputToken, value: 0n, data: allowanceHolderApprove(0n) }]),
      { to: quote.inputToken, value: 0n, data: allowanceHolderApprove(quote.inputAmount) },
      { to: spokePool, value: 0n, data },
    ];
    return {
      kind: "call",
      to: from,
      value: 0n,
      data: encodeBatchExecute(
        calls.map((c) => ({ to: checksumEvmAddress(c.to), value: c.value, data: c.data })),
      ),
    };
  };

  /**
   * `evm-delegation` (upgrade/revoke) and `evm-batch`: internal, group-scoped self-transactions —
   * the batch upgrades the account to the delegator when it is not already delegated to it.
   */
  const ERC165_ABI = [
    {
      type: "function",
      name: "supportsInterface",
      stateMutability: "view",
      inputs: [{ name: "interfaceId", type: "bytes4" }],
      outputs: [{ name: "", type: "bool" }],
    },
  ] as const;
  const ERC721_ABI = [
    {
      type: "function",
      name: "ownerOf",
      stateMutability: "view",
      inputs: [{ name: "tokenId", type: "uint256" }],
      outputs: [{ name: "", type: "address" }],
    },
    {
      type: "function",
      name: "safeTransferFrom",
      stateMutability: "nonpayable",
      inputs: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      outputs: [],
    },
  ] as const;
  const ERC1155_ABI = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [
        { name: "account", type: "address" },
        { name: "id", type: "uint256" },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
    {
      type: "function",
      name: "safeTransferFrom",
      stateMutability: "nonpayable",
      inputs: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "id", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
      outputs: [],
    },
  ] as const;
  const ERC721_INTERFACE = "0x80ac58cd";
  const ERC1155_INTERFACE = "0xd9b67a26";

  /* A cross-checked read on both endpoints: a successful disagreeing read refuses, a failed
     independent read degrades to `reads-unverified` — same rule as the swap path. */

  /* `evm-nft-send`: detect the standard by ERC-165, check ownership, build safeTransferFrom. */
  const prepareNftSend = async (
    ctx: RouteContext,
    input: Extract<ChainRequestInput, { method: "evm-nft-send" }>,
    from: string,
    flags: Array<RequestCheckCode | undefined>,
  ): Promise<BuildIntent> => {
    const { network, contract, tokenId } = input;
    let { to } = input;
    if (!isAddress(to) && to.includes(".")) {
      const resolved = await resolveEns(ctx.options.networks, to, network);
      to = resolved.address;
      flags.push(...resolved.checks);
    }
    const c = getAddress(contract);
    const supports721 = await nftRead(
      ctx,
      network,
      async (client) =>
        readContract(client, {
          address: c,
          abi: ERC165_ABI,
          functionName: "supportsInterface",
          args: [ERC721_INTERFACE],
        }),
      flags,
    );
    const supports1155 = await nftRead(
      ctx,
      network,
      async (client) =>
        readContract(client, {
          address: c,
          abi: ERC165_ABI,
          functionName: "supportsInterface",
          args: [ERC1155_INTERFACE],
        }),
      flags,
    );
    if (!supports721 && !supports1155) {
      throw new ChainError("invalid-request", "the contract is neither ERC-721 nor ERC-1155");
    }
    if (supports721) {
      const owner = await nftRead(
        ctx,
        network,
        async (client) =>
          readContract(client, {
            address: c,
            abi: ERC721_ABI,
            functionName: "ownerOf",
            args: [tokenId],
          }) as Promise<string>,
        flags,
      );
      if (owner.toLowerCase() !== from.toLowerCase()) {
        throw new ChainError("invalid-request", "the account does not own the token");
      }
      return guardNftCall(
        input,
        from,
        to,
        tokenId,
        1n,
        encodeFunctionData({
          abi: ERC721_ABI,
          functionName: "safeTransferFrom",
          args: [getAddress(from), getAddress(to), tokenId],
        }),
      );
    }
    const amount = input.amount ?? 1n;
    if (amount < 1n) {
      throw new ChainError("invalid-request", "an ERC-1155 send needs at least one unit");
    }
    const balance = await nftRead(
      ctx,
      network,
      async (client) =>
        readContract(client, {
          address: c,
          abi: ERC1155_ABI,
          functionName: "balanceOf",
          args: [getAddress(from), tokenId],
        }),
      flags,
    );
    if (balance < amount) {
      throw new ChainError("invalid-request", "the account does not hold enough units");
    }
    return guardNftCall(
      input,
      from,
      to,
      tokenId,
      amount,
      encodeFunctionData({
        abi: ERC1155_ABI,
        functionName: "safeTransferFrom",
        args: [getAddress(from), getAddress(to), tokenId, amount, "0x"],
      }),
    );
  };

  const prepareEvmInternal = async (
    ctx: RouteContext,
    input: EvmInternalInput,
  ): Promise<PreparedRequest> => {
    const { account, network, fee } = input;
    if (input.method === "evm-lido" && network !== "eip155:1") {
      throw new ChainError("invalid-request", "Lido staking is Ethereum mainnet only");
    }
    const from = await resolveFrom(ctx, account, network);
    const flags: Array<RequestCheckCode | undefined> = [];
    let intent: BuildIntent;
    let warnings: ReadonlyArray<IntentWarning> = [];
    if (input.method === "evm-delegation") {
      const state = await delegationState(ctx, network, from, flags);
      if (input.action === "upgrade" && state.kind === "ours") {
        throw new ChainError("invalid-request", "account is already delegated");
      }
      if (input.action === "revoke" && state.kind === "none") {
        throw new ChainError("invalid-request", "account has no delegation to revoke");
      }
      intent = {
        kind: "call",
        to: from,
        value: 0n,
        data: "0x",
        authorization: {
          address:
            input.action === "revoke"
              ? "0x0000000000000000000000000000000000000000"
              : EVM_DELEGATOR.address,
        },
      };
    } else if (input.method === "evm-approve") {
      intent = await prepareApproveIntent(ctx, input, from, flags);
    } else if (input.method === "evm-swap") {
      intent = await prepareSwapIntent(ctx, input, from, flags);
    } else if (input.method === "evm-bridge") {
      intent = await prepareBridgeIntent(ctx, input, from, flags);
    } else if (input.method === "evm-nft-send") {
      intent = await prepareNftSend(ctx, input, from, flags);
    } else if (input.method === "evm-lido") {
      intent = await prepareLidoIntent(ctx, input, from, flags, async () =>
        delegationStateOrNone(ctx, network, from, flags),
      );
    } else {
      const state = await delegationState(ctx, network, from, flags);
      if (input.calls.length < 2) {
        throw new ChainError("invalid-request", "a batch needs at least two calls");
      }
      if (input.calls.length > EVM_BATCH_LIMIT) {
        throw new ChainError("invalid-request", `a batch allows at most ${EVM_BATCH_LIMIT} calls`);
      }
      const calls = input.calls.map((c) => ({
        to: checksumEvmAddress(c.to),
        value: c.value,
        data: c.data,
      }));
      if (calls.some((c) => c.to.toLowerCase() === from.toLowerCase())) {
        /* msg.sender == address(this) inside the delegator reaches its admin methods. */
        throw new ChainError("invalid-request", "a batch call to your own account is refused");
      }
      if (input.origin !== undefined && state.kind === "other") {
        /* A page may not replace a delegation the user set elsewhere — only the wallet may. */
        throw new ChainError("invalid-request", "the account is already delegated elsewhere");
      }
      if (state.kind === "other") {
        warnings = [
          {
            kind: "delegation-replaced",
            message: `this batch replaces an existing delegation to ${state.address}`,
          },
        ];
      }
      intent = {
        kind: "call",
        to: from,
        value: 0n,
        data: encodeBatchExecute(calls),
        ...(state.kind === "ours" ? {} : { authorization: { address: EVM_DELEGATOR.address } }),
      };
    }
    const prepared = await prepareSpec(ctx, {
      account,
      network,
      from,
      fee,
      intent,
      nativeValue: undefined,
    });
    if (input.method === "evm-lido") {
      assertLidoIntent(input.action, prepared.intent);
      return {
        ...prepared,
        checks: [...new Set([...prepared.checks, ...collectChecks(flags)])],
      };
    }
    if (input.method === "evm-swap" || input.method === "evm-bridge") {
      /* The simulation is mandatory and must keep the quote's terms, now and at approval. */
      const gasCost = BigInt(prepared.intent.fee?.max.amount ?? "0");
      if (input.method === "evm-swap") {
        assertSwapSimulation(input.quote, prepared.simulation, gasCost);
      } else {
        assertBridgeSimulation(input.quote, prepared.simulation, gasCost);
      }
      const rerun = prepared.resimulate;
      const resimulate =
        rerun === undefined
          ? undefined
          : async () => {
              const outcome = await rerun();
              if (input.method === "evm-swap") {
                assertSwapSimulation(input.quote, outcome, gasCost);
              } else {
                assertBridgeSimulation(input.quote, outcome, gasCost);
              }
              return outcome;
            };
      return {
        ...prepared,
        ...(resimulate === undefined ? {} : { resimulate }),
        intent: { ...prepared.intent, warnings: [...prepared.intent.warnings, ...warnings] },
        checks: [...new Set([...prepared.checks, ...collectChecks(flags)])],
      };
    }
    return {
      ...prepared,
      intent: { ...prepared.intent, warnings: [...prepared.intent.warnings, ...warnings] },
      checks: [...new Set([...prepared.checks, ...collectChecks(flags)])],
    };
  };

  const prepare = async (ctx: RouteContext, params: PrepareParams): Promise<PreparedRequest> => {
    let { to } = params;
    let name: string | undefined;
    let nameChecks: ReadonlyArray<RequestCheckCode> = [];
    if (!isAddress(to) && to.includes(".")) {
      const resolved = await resolveEns(ctx.options.networks, to, params.network);
      ({ address: to, name, checks: nameChecks } = resolved);
    }
    const prepared = await prepareSpec(ctx, {
      account: params.account,
      network: params.network,
      from: await resolveFrom(ctx, params.account, params.network),
      fee: params.fee,
      intent:
        params.token === undefined
          ? { kind: "native", to, value: params.amount }
          : { kind: "erc20", token: params.token, to, value: params.amount },
      nativeValue: params.token === undefined ? params.amount : undefined,
    });
    if (name === undefined) {
      return prepared;
    }
    return {
      ...prepared,
      intent: {
        ...prepared.intent,
        outflows: prepared.intent.outflows.map((flow) =>
          flow.to.toLowerCase() === to.toLowerCase() ? { ...flow, name } : flow,
        ),
      },
      checks: [...new Set([...nameChecks, ...prepared.checks])],
    };
  };

  /**
   * A dApp transaction, already normalized: only `to`, `value` and `data` are kept; nonce and fees
   * are read again and the dApp's `gas` only raises the floor under our own estimate.
   */
  const prepareCall = async (
    ctx: RouteContext,
    request: {
      readonly account: PrepareParams["account"];
      readonly network: string;
      readonly tx: {
        readonly to?: string;
        readonly value: string;
        readonly data: string;
        readonly gas: string;
      };
    },
  ): Promise<PreparedRequest> => {
    const { tx } = request;
    if (tx.to === undefined) {
      throw new Error("contract creation is not supported");
    }
    const value = BigInt(tx.value);
    const from = await resolveFrom(ctx, request.account, request.network);
    if (tx.data !== "0x" && tx.to.toLowerCase() === from.toLowerCase()) {
      throw new ChainError(
        "invalid-request",
        "dApp transactions calling your own account are refused",
      );
    }
    return prepareSpec(ctx, {
      account: request.account,
      network: request.network,
      from,
      fee: "normal",
      intent: { kind: "call", to: tx.to, value, data: tx.data, minGas: BigInt(tx.gas) },
      nativeValue: value > 0n ? value : undefined,
    });
  };

  /**
   * EVM speed-up/cancel — replaces a pending tx at the same nonce with a bumped fee (cancel = a
   * 0-value transfer to self). The fee is cross-checked and merged first, then the replacement
   * floor (+10% on both fee fields, never below the merged estimate) is applied on top, so a low
   * quote can never push the replacement under the node's replacement rule. A rejected signature
   * never reaches the network and leaves the original.
   */
  const prepareReplace = async (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
  ): Promise<PreparedRequest> => {
    const { evm: record } = old;
    if (record === undefined) {
      throw new Error("transaction has no build record — cannot replace");
    }
    const { networks } = ctx.options;
    const client = networks.client(old.network);
    const independent = networks.independentClient(old.network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const { chainId } = networks.info(old.network);
    const original = rebuild(old, record.from, record.raw, chainId);
    const account = {
      kind: "hd" as const,
      walletId: old.account,
      groupIndex: record.groupIndex,
      template: "evm.bip44" as const,
    };
    const estimates = await evm.estimateFee(client);
    let estimate = estimates.find((q) => q.tier === "fast") ?? estimates[1];
    if (estimate === undefined) {
      throw new Error("no fee quote");
    }
    const flags: Array<RequestCheckCode | undefined> = [
      independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ];
    let independentCap: bigint | undefined;
    if (independent.kind === "available") {
      try {
        const others = await evm.estimateFee(independent.client);
        const other = others.find((q) => q.tier === estimate?.tier);
        if (other === undefined) {
          flags.push("reads-unverified");
        } else {
          const merged = mergeEvmQuote(estimate, other);
          ({ quote: estimate } = merged);
          independentCap = other.maxFeePerGas;
          flags.push(merged.mismatch ? "fee-mismatch" : undefined);
        }
      } catch {
        flags.push("reads-unverified");
      }
    }
    const oldFee = original;
    const bumpedFee = bump(oldFee.maxFeePerGas ?? oldFee.gasPrice ?? 0n);
    const maxFeePerGas = bumpedFee > estimate.maxFeePerGas ? bumpedFee : estimate.maxFeePerGas;
    const priorityBump =
      oldFee.maxPriorityFeePerGas === undefined && estimate.maxPriorityFeePerGas === undefined
        ? undefined
        : bump(oldFee.maxPriorityFeePerGas ?? 0n) > (estimate.maxPriorityFeePerGas ?? 0n)
          ? bump(oldFee.maxPriorityFeePerGas ?? 0n)
          : (estimate.maxPriorityFeePerGas ?? 0n);
    const feeFields =
      priorityBump === undefined
        ? { maxFeePerGas }
        : { maxFeePerGas, maxPriorityFeePerGas: priorityBump };
    if (independentCap !== undefined) {
      flags.push(exceedsNetworkCap(maxFeePerGas, independentCap) ? "fee-above-network" : undefined);
    }
    const unsigned =
      mode === "cancel"
        ? {
            ...original,
            to: original.from,
            value: 0n,
            data: "0x" as const,
            gas: 21000n,
            authorization: undefined,
            ...feeFields,
          }
        : { ...original, ...feeFields };
    const request = evm.toSignRequest(unsigned, account, chainId);
    const l1 =
      networks.info(old.network).opStack === true
        ? await opStackFee(ctx, old.network, unsigned, flags)
        : undefined;
    const intent = withL1Fee(decodeEvm(request, original.from), l1);
    const txId = newId(ctx.options.random);

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
      let tx: TrackedTransaction = {
        id: txId,
        family: "evm",
        network: old.network,
        account: old.account,
        hash: undefined,
        state: "draft",
        intent,
        nonce: old.nonce,
        replaces: old.id,
        submittedAt: ctx.options.now(),
        error: undefined,
      };
      tx = await ctx.transition(tx, {});
      return signSubmit(
        ctx,
        tx,
        apis,
        request,
        verify,
        { from: record.from, groupIndex: record.groupIndex },
        async (signed) => {
          const raw = evm.finalize(unsigned, signed);
          return { hash: await evm.broadcast(client, raw), raw };
        },
      );
    };

    return {
      txId,
      account,
      network: old.network,
      target: old.id,
      intent,
      checks: collectChecks(flags),
      staleReason: () => replacementStaleReason(ctx, old.id),
      submit,
      release: () => undefined,
    };
  };

  const receiptState = async (
    client: ReturnType<RouteContext["options"]["networks"]["client"]>,
    hash: string,
  ): Promise<TxState | undefined> => {
    const state = await evm.status(client, hash);
    if (state === "pending") {
      return undefined;
    }
    return state === "finalized" ? "confirmed" : state;
  };

  const anyMined = async (
    ctx: RouteContext,
    tx: TrackedTransaction,
    siblings: TrackedTransaction[],
  ): Promise<boolean> => {
    const client = ctx.options.networks.client(tx.network);
    const states = await Promise.all(
      siblings.map(async (t) => (t.hash === undefined ? undefined : receiptState(client, t.hash))),
    );
    return states.some((state) => state !== undefined);
  };

  /**
   * Returns the terminal state once the receipt lands, `dropped` or `replaced` once the nonce is
   * settled without our receipt, or `undefined` to keep polling. While the node does not know the
   * transaction it is rebroadcast with exponential backoff.
   */
  const poll = async (ctx: RouteContext, tx: TrackedTransaction): Promise<TxState | undefined> => {
    if (tx.hash === undefined) {
      return "failed";
    }
    const { hash } = tx;
    const client = ctx.options.networks.client(tx.network);
    const settled = await receiptState(client, hash);
    if (settled !== undefined) {
      watching.delete(tx.id);
      return settled;
    }
    const record = tx.evm;
    if (record === undefined) {
      return undefined;
    }
    const watch: Watch = watching.get(tx.id) ?? {
      consumed: 0,
      attempt: 0,
      unknownSince: undefined,
      nextResubmit: undefined,
    };
    watching.set(tx.id, watch);

    if ((await evm.confirmedCount(client, record.from)) > tx.nonce) {
      const late = await receiptState(client, hash);
      if (late !== undefined) {
        watching.delete(tx.id);
        return late;
      }
      watch.consumed += 1;
      if (watch.consumed < DROP_CONFIRMATIONS) {
        return undefined;
      }
      watching.delete(tx.id);
      return (await anyMined(ctx, tx, sameNonce(ctx, tx, record.from))) ? "replaced" : "dropped";
    }
    watch.consumed = 0;

    const replacerLive = sameNonce(ctx, tx, record.from).some(
      (t) => t.replaces === tx.id && (t.state === "submitted" || t.state === "pending"),
    );
    if (replacerLive) {
      watch.unknownSince = undefined;
      watch.nextResubmit = undefined;
      watch.attempt = 0;
      return undefined;
    }

    if (await evm.known(client, hash)) {
      watch.unknownSince = undefined;
      watch.nextResubmit = undefined;
      watch.attempt = 0;
      return undefined;
    }
    const now = ctx.options.now();
    watch.unknownSince ??= now;
    if (now - watch.unknownSince >= UNKNOWN_DROP_MS) {
      const independent = ctx.options.networks.independentClient(tx.network);
      const elsewhere =
        independent.kind === "available" &&
        (await evm.known(independent.client, hash).catch(() => true));
      if (!elsewhere) {
        evm.releaseNonce(tx.network, record.from, tx.nonce);
        watching.delete(tx.id);
        return "dropped";
      }
    }
    if (watch.nextResubmit === undefined || now >= watch.nextResubmit) {
      await evm.broadcast(client, record.raw).catch(() => "");
      watch.nextResubmit = now + Math.min(RESUBMIT_BASE_MS * 2 ** watch.attempt, RESUBMIT_MAX_MS);
      watch.attempt += 1;
    }
    return undefined;
  };

  const readDelegationState = async (
    ctx: RouteContext,
    network: string,
    from: string,
  ): Promise<DelegationStatus> => {
    const info = ctx.options.networks.info(network);
    if (info.delegatorCodeHash === undefined) {
      return { supported: false, state: "none" };
    }
    const state = await evm.delegation(ctx.options.networks.client(network), from);
    return {
      supported: true,
      state: state.kind,
      ...(state.kind === "other" ? { address: state.address } : {}),
    };
  };

  return {
    prepare,
    prepareCall,
    delegationState: readDelegationState,
    prepareEvmInternal,
    poll,
    prepareReplace,
  };
};
