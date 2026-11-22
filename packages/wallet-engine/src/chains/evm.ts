/**
 * EVM chain adapter: native transfers through a viem PublicClient injected by NetworkController.
 * Fee tiers come from eth_feeHistory (20 blocks, p10/p50/p90 → slow/normal/fast, maxFee = 2×baseFee +
 * priority) unless the chain's pricing is `legacy`, which quotes eth_gasPrice for every tier;
 * feeHistory failures fall back to it too. gas = estimateGas × 1.2 (ceil). Finalization uses the
 * `finalized` block tag; receipts with status 0 fail.
 */
import {
  encodeFunctionData,
  isAddress,
  isHex,
  keccak256,
  numberToHex,
  parseAbi,
  serializeTransaction,
} from "viem";
import type { PublicClient, TransactionSerializable } from "viem";
import { readContract, simulateCalls } from "viem/actions";
import { estimateL1Fee } from "viem/op-stack";

import type { AccountRef, EvmTransaction, SignRequest } from "@qntx/wallet-chains";
import { ChainError } from "@qntx/wallet-chains";
import {
  EVM_DELEGATOR,
  EVM_DELEGATION_PREFIX,
  EVM_NATIVE_ASSET,
  checksumEvmAddress,
  evmTokenTable,
  lookupEvmToken,
  networkChainId,
} from "@qntx/wallet-chains/evm";

import { TOKEN_SYMBOL_MAX, safeDecimals, safeDisplayText } from "../display.ts";
import { errorMessage } from "../errors.ts";
import type { GasPricing } from "../networks/registry.ts";
import { boundedSimulation } from "../requests/simulation.ts";
import type { AssetChange, SimulationOutcome } from "../requests/simulation.ts";

export type EvmSignRequest = Extract<SignRequest, { kind: "evm.transaction" }>;
export type EvmSignResult = {
  readonly kind: "evm.transaction";
  readonly signedTransaction: Uint8Array;
};

export type EvmFeeTier = "slow" | "normal" | "fast";

export type EvmUnsignedTransaction = {
  readonly family: "evm";
  readonly network: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly nonce: number;
  readonly gas: bigint;
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  /** Present iff the transaction carries one self-sponsored EIP-7702 authorization. */
  readonly authorization?: { readonly address: string } | undefined;
};

export type EvmFeeQuote = {
  readonly tier: EvmFeeTier;
  readonly wei: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint | undefined;
};

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

/** OP Stack GasPriceOracle predeploy; viem's `op-stack` entry does not export its ABI or address. */
export const OP_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const OP_GAS_PRICE_ORACLE_ABI = parseAbi([
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
  "function tokenRatio() view returns (uint256)",
]);

/** One L1 price update lands per 12 s L1 slot. */
export const L1_SLOT_MS = 12_000;

/**
 * The most an L1 fee-oracle read of `raw` can have risen after `updates` L1 price updates: ceil(raw
 * × (9/8)^updates). EIP-1559's base fee moves at most ×9/8 per block, and EIP-4844's blob base fee
 * does not move faster either (EIP-4844's ×1.0817 target under EIP-7691's and EIP-7892's updated
 * parameters), so one bound covers the OP Stack and Scroll oracles alike. Re-sampled over 436
 * mainnet transactions on OP Mainnet and Scroll (2026-11-21, including a blob-fee spike): `raw ×
 * (9/8)^(floor(d / 12 s) + 1)` read d seconds before inclusion never fell below the receipt's
 * l1Fee.
 */
export const l1FeeBound = (raw: bigint, updates: number): bigint =>
  ceilDiv(raw * 9n ** BigInt(updates), 8n ** BigInt(updates));

/** An L1 fee oracle's read: the floating data fee and the flat charge besides it. */
export type L1FeeRead = {
  /** The L1 data fee — bound through {@link l1FeeBound} before it is relied on. */
  readonly raw: bigint;
  /** The flat operator fee at the gas limit (0 on Scroll); it never floats. */
  readonly extra: bigint;
};

/** Scroll L1GasPriceOracle predeploy; `getL1Fee` prices the signed transaction's RLP. */
export const SCROLL_L1_GAS_PRICE_ORACLE = "0x5300000000000000000000000000000000000002";
const SCROLL_L1_GAS_PRICE_ORACLE_ABI = parseAbi([
  "function getL1Fee(bytes data) view returns (uint256)",
]);

/**
 * The largest signature viem can encode, yParity 1 (v = 28). Serializing under it is never shorter
 * than the real signed encoding, so an oracle pricing the signed RLP sees the maximum.
 */
const MAX_SIGNATURE = {
  r: `0x${"ff".repeat(32)}`,
  s: `0x${"ff".repeat(32)}`,
  v: 28n,
} as const;

/**
 * `tx` as viem serializes it — the same fields `toSignRequest` would sign: legacy when a `gasPrice`
 * was quoted, eip7702 when it carries a self-sponsored authorization (its authorization is the
 * account's next-but-one nonce, signed under `MAX_SIGNATURE`), else eip1559.
 */
const serializable = (tx: EvmUnsignedTransaction): TransactionSerializable => {
  const base = {
    chainId: networkChainId(tx.network),
    nonce: tx.nonce,
    gas: tx.gas,
    to: checkedAddress(tx.to),
    value: tx.value,
    data: checkedHex(tx.data),
  };
  if (tx.gasPrice !== undefined) {
    return { ...base, type: "legacy", gasPrice: tx.gasPrice };
  }
  const dynamic = {
    ...base,
    accessList: [],
    maxFeePerGas: tx.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
  };
  if (tx.authorization === undefined) {
    return { ...dynamic, type: "eip1559" };
  }
  return {
    ...dynamic,
    type: "eip7702",
    authorizationList: [
      {
        chainId: base.chainId,
        address: checkedAddress(tx.authorization.address),
        nonce: tx.nonce + 1,
        ...MAX_SIGNATURE,
      },
    ],
  };
};

const ceilDiv = (v: bigint, denominator: bigint): bigint =>
  v / denominator + (v % denominator === 0n ? 0n : 1n);

const checkedAddress = (v: string): `0x${string}` => {
  if (!isAddress(v)) {
    throw new TypeError(`malformed evm address: ${v}`);
  }
  return v;
};

/** A contract's own `symbol` and `decimals`, kept only when they are safe to show. */
const unverifiedMetadata = (token: {
  readonly symbol?: string | undefined;
  readonly decimals?: number | undefined;
}): { symbol?: string; decimals?: number } => {
  const symbol =
    token.symbol === undefined ? undefined : safeDisplayText(token.symbol, TOKEN_SYMBOL_MAX);
  const decimals = token.decimals === undefined ? undefined : safeDecimals(token.decimals);
  return {
    ...(decimals === undefined ? {} : { decimals }),
    ...(symbol === undefined ? {} : { symbol }),
  };
};

export const checkedHex = (v: string): `0x${string}` => {
  if (!isHex(v, { strict: true }) || v.length % 2 !== 0) {
    throw new TypeError("malformed hex data");
  }
  return v;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const checkedBlockHash = (v: unknown): string => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new TypeError("malformed block hash");
  }
  return v;
};

/** A JSON-RPC hex quantity as a safe non-negative integer. */
const hexHeight = (v: unknown): number => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) {
    throw new TypeError("malformed block number");
  }
  const height = Number(BigInt(v));
  if (!Number.isSafeInteger(height)) {
    throw new TypeError("block number out of range");
  }
  return height;
};

/** A JSON-RPC hex quantity the spec guarantees — missing or malformed throws, never 0. */
const hexQuantity = (v: unknown, method: string): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) {
    throw new TypeError(`${method}: malformed quantity`);
  }
  return BigInt(v);
};

const hex = (v: bigint | number): string => numberToHex(v);

const evmRpc = async (client: PublicClient, method: string, params: unknown[]): Promise<unknown> =>
  client.transport.request({ method, params });

const transactionCount = async (
  client: PublicClient,
  from: string,
  tag: string,
): Promise<number> => {
  const n = Number(
    hexQuantity(
      await evmRpc(client, "eth_getTransactionCount", [from, tag]),
      "eth_getTransactionCount",
    ),
  );
  if (!Number.isSafeInteger(n)) {
    throw new TypeError("eth_getTransactionCount: malformed quantity");
  }
  return n;
};

export const evmRpcHex = async (
  client: PublicClient,
  method: string,
  params: unknown[],
): Promise<string> => {
  const result: unknown = await evmRpc(client, method, params);
  if (typeof result !== "string") {
    throw new TypeError(`${method} returned a malformed result`);
  }
  return result;
};

/** Viem's marker for the chain's native asset in traced asset changes. */
const NATIVE_MARKER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type EvmSimulationCall = {
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
};

export class EvmChainAdapter {
  readonly family = "evm";

  /** The endpoint's pending transaction count for `from`. */
  async pendingCount(client: PublicClient, from: string): Promise<number> {
    return transactionCount(client, from, "pending");
  }

  /** The endpoint's mined transaction count for `from`: every nonce below it is consumed. */
  async confirmedCount(client: PublicClient, from: string): Promise<number> {
    return transactionCount(client, from, "latest");
  }

  /** True when the endpoint knows the transaction, mined or in its pool. */
  async known(client: PublicClient, hash: string): Promise<boolean> {
    const found: unknown = await evmRpc(client, "eth_getTransactionByHash", [hash]);
    return typeof found === "object" && found !== null;
  }

  /** The account's 7702 delegation state from `eth_getCode`; throws when it is not an EOA. */
  async delegation(
    client: PublicClient,
    address: string,
  ): Promise<
    | { readonly kind: "none" }
    | { readonly kind: "ours" }
    | { readonly kind: "other"; readonly address: string }
  > {
    const code = await evmRpcHex(client, "eth_getCode", [address, "latest"]);
    if (code === "0x") {
      return { kind: "none" };
    }
    if (!code.toLowerCase().startsWith(EVM_DELEGATION_PREFIX) || code.length !== 48) {
      throw new ChainError("unsupported", "account is not an EOA");
    }
    const target = checksumEvmAddress(`0x${code.slice(8)}`);
    return target === EVM_DELEGATOR.address ? { kind: "ours" } : { kind: "other", address: target };
  }

  /** Keccak256 of the delegator's runtime code equals the expected registry hash. */
  async delegatorVerified(client: PublicClient, expectedHash: string): Promise<boolean> {
    const code = await evmRpcHex(client, "eth_getCode", [EVM_DELEGATOR.address, "latest"]);
    return code !== "0x" && keccak256(checkedHex(code)) === expectedHash;
  }

  /**
   * OP Stack fees charged on top of gas × gas price: `raw` is the L1 data fee as the oracle read it
   * — at the chain's `tokenRatio` where the model prices it in another token (Mantle) — and `extra`
   * the flat operator fee at the full gas limit where the oracle prices one (pre-Isthmus oracles
   * revert on it). Callers bound `raw` through {@link l1FeeBound}; `extra` never floats.
   */
  async opStackFee(
    client: PublicClient,
    tx: EvmUnsignedTransaction,
    model: { readonly operatorFee: boolean; readonly tokenRatio: boolean },
  ): Promise<L1FeeRead> {
    const [l1, operator, ratio] = await Promise.all([
      estimateL1Fee(client, {
        chain: null,
        account: checkedAddress(tx.from),
        to: checkedAddress(tx.to),
        value: tx.value,
        data: checkedHex(tx.data),
      }),
      model.operatorFee
        ? readContract(client, {
            address: OP_GAS_PRICE_ORACLE,
            abi: OP_GAS_PRICE_ORACLE_ABI,
            functionName: "getOperatorFee",
            args: [tx.gas],
          })
        : Promise.resolve(0n),
      model.tokenRatio
        ? readContract(client, {
            address: OP_GAS_PRICE_ORACLE,
            abi: OP_GAS_PRICE_ORACLE_ABI,
            functionName: "tokenRatio",
          })
        : Promise.resolve(1n),
    ]);
    return { raw: l1 * ratio, extra: operator };
  }

  /**
   * Scroll's L1 data fee for `tx` in `raw`: the oracle prices the signed RLP, which pre-signing is
   * the transaction serialized under `MAX_SIGNATURE` — an upper bound on the real encoding's
   * length. Scroll charges no operator fee; callers bound `raw` through {@link l1FeeBound}.
   */
  async scrollL1Fee(client: PublicClient, tx: EvmUnsignedTransaction): Promise<L1FeeRead> {
    const raw = await readContract(client, {
      address: SCROLL_L1_GAS_PRICE_ORACLE,
      abi: SCROLL_L1_GAS_PRICE_ORACLE_ABI,
      functionName: "getL1Fee",
      args: [serializeTransaction(serializable(tx), MAX_SIGNATURE)],
    });
    return { raw, extra: 0n };
  }

  /** ERC-20 gas is buffered ×1.1 instead of the native ×1.2 (chains.mdx "EVM"). */
  async build(
    client: PublicClient,
    network: string,
    from: string,
    intent:
      | { readonly kind: "native"; readonly to: string; readonly value: bigint }
      | {
          readonly kind: "erc20";
          readonly token: string;
          readonly to: string;
          readonly value: bigint;
        }
      | {
          /** An arbitrary call; `minGas` is its own gas figure, a floor under ours. */
          readonly kind: "call";
          readonly to: string;
          readonly value: bigint;
          readonly data: string;
          readonly minGas?: bigint;
          /** A self-sponsored EIP-7702 authorization this transaction carries. */
          readonly authorization?: { readonly address: string };
        },
    nonce: number,
  ): Promise<EvmUnsignedTransaction> {
    const erc20 = intent.kind === "erc20";
    const to = checksumEvmAddress(erc20 ? intent.token : intent.to);
    const value = erc20 ? 0n : intent.value;
    const data = erc20
      ? encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [checkedAddress(intent.to), intent.value],
        })
      : intent.kind === "call"
        ? intent.data
        : "0x";
    const authorization = intent.kind === "call" ? intent.authorization : undefined;
    /** Estimate the call as it will run: the sender's code overridden to the delegator designator. */
    const override =
      authorization?.address === EVM_DELEGATOR.address
        ? { [from]: { code: `${EVM_DELEGATION_PREFIX}${EVM_DELEGATOR.address.slice(2)}` } }
        : undefined;
    const params: unknown[] =
      override === undefined
        ? [{ from, to, value: hex(value), data }]
        : [{ from, to, value: hex(value), data }, "latest", override];
    const estimate =
      hexQuantity(await evmRpc(client, "eth_estimateGas", params), "eth_estimateGas") +
      (authorization === undefined ? 0n : 25_000n);
    const scale = erc20 ? 11n : 12n;
    const buffered = (estimate * scale) / 10n + ((estimate * scale) % 10n === 0n ? 0n : 1n);
    const minGas = intent.kind === "call" ? (intent.minGas ?? 0n) : 0n;
    const gas = buffered > minGas ? buffered : minGas;
    return {
      family: "evm",
      network,
      from,
      to,
      value,
      data,
      nonce,
      gas,
      ...(authorization === undefined ? {} : { authorization }),
    };
  }

  async estimateFee(
    client: PublicClient,
    pricing: GasPricing,
  ): Promise<ReadonlyArray<EvmFeeQuote>> {
    const gasPrice = async (): Promise<ReadonlyArray<EvmFeeQuote>> => {
      const price = hexQuantity(await evmRpc(client, "eth_gasPrice", []), "eth_gasPrice");
      return (["slow", "normal", "fast"] as const).map((name) => ({
        tier: name,
        wei: price,
        maxFeePerGas: price,
        maxPriorityFeePerGas: undefined,
      }));
    };
    if (pricing === "legacy") {
      return gasPrice();
    }
    try {
      const history: unknown = await evmRpc(client, "eth_feeHistory", [
        "0x14",
        "latest",
        [10, 50, 90],
      ]);
      if (
        typeof history !== "object" ||
        history === null ||
        !("baseFeePerGas" in history) ||
        !Array.isArray(history.baseFeePerGas) ||
        !("reward" in history) ||
        !Array.isArray(history.reward)
      ) {
        throw new TypeError("eth_feeHistory returned a malformed result");
      }
      const { baseFeePerGas, reward } = history;
      if (
        !Array.isArray(baseFeePerGas) ||
        baseFeePerGas.length === 0 ||
        !baseFeePerGas.every((v) => typeof v === "string") ||
        !Array.isArray(reward) ||
        reward.length === 0 ||
        !reward.every((r) => Array.isArray(r) && r.every((v) => typeof v === "string")) ||
        !reward.every((r) => r.length >= 3)
      ) {
        throw new TypeError("eth_feeHistory returned a malformed result");
      }
      const baseFee = BigInt(baseFeePerGas.at(-1) ?? "0x0");
      const tier = (i: number, name: EvmFeeTier): EvmFeeQuote => {
        const last = reward.at(-1);
        const priority = last === undefined ? 0n : BigInt(last[i] ?? "0x0");
        const maxFeePerGas = baseFee * 2n + priority;
        return { tier: name, wei: maxFeePerGas, maxFeePerGas, maxPriorityFeePerGas: priority };
      };
      return [tier(0, "slow"), tier(1, "normal"), tier(2, "fast")];
    } catch {
      return gasPrice();
    }
  }

  applyFee(tx: EvmUnsignedTransaction, fee: EvmFeeQuote): EvmUnsignedTransaction {
    if (fee.maxPriorityFeePerGas === undefined) {
      return { ...tx, gasPrice: fee.maxFeePerGas };
    }
    return {
      ...tx,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    };
  }

  toSignRequest<A extends AccountRef>(
    tx: EvmUnsignedTransaction,
    account: A,
    chainId: number,
  ): EvmSignRequest & { readonly account: A } {
    const base = {
      chainId,
      nonce: tx.nonce,
      gas: hex(tx.gas),
      to: tx.to,
      value: hex(tx.value),
      data: tx.data,
    };
    const transaction: EvmTransaction =
      tx.gasPrice === undefined
        ? tx.authorization === undefined
          ? {
              ...base,
              type: "eip1559",
              accessList: [],
              maxFeePerGas: hex(tx.maxFeePerGas ?? 0n),
              maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? 0n),
            }
          : {
              ...base,
              type: "eip7702",
              accessList: [],
              maxFeePerGas: hex(tx.maxFeePerGas ?? 0n),
              maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? 0n),
              authorization: { address: tx.authorization.address },
            }
        : { ...base, type: "legacy", gasPrice: hex(tx.gasPrice) };
    return { kind: "evm.transaction", network: tx.network, account, tx: transaction };
  }

  finalize(
    _tx: EvmUnsignedTransaction,
    signed: { kind: string; signedTransaction?: Uint8Array },
  ): string {
    const bytes = signed.signedTransaction;
    if (signed.kind !== "evm.transaction" || bytes === undefined) {
      throw new Error(`unexpected sign result ${signed.kind}`);
    }
    return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  /**
   * Simulates one call from `from` with traced asset changes. A revert is `reverted`; an
   * unsupported method, any thrown error or the timeout is `unavailable`. The result is for display
   * only.
   */
  async simulate(
    client: PublicClient,
    chainId: number,
    from: string,
    call: EvmSimulationCall,
    setTimer: (ms: number, fn: () => unknown) => () => void,
    delegatedCode?: string,
  ): Promise<SimulationOutcome> {
    return boundedSimulation(async () => {
      const result = await simulateCalls(client, {
        account: checkedAddress(from),
        calls: [{ to: checkedAddress(call.to), value: call.value, data: checkedHex(call.data) }],
        traceAssetChanges: true,
        ...(delegatedCode === undefined
          ? {}
          : {
              stateOverrides: [{ address: checkedAddress(from), code: checkedHex(delegatedCode) }],
            }),
      });
      const [first] = result.results;
      if (first?.status === "failure") {
        return { status: "reverted", error: errorMessage(first.error) };
      }
      const changes: AssetChange[] = [];
      for (const change of result.assetChanges) {
        if (change.value.diff === 0n) {
          continue;
        }
        const address = change.token.address.toLowerCase();
        if (address === NATIVE_MARKER) {
          changes.push({
            asset: EVM_NATIVE_ASSET,
            amount: change.value.diff.toString(10),
            verified: true,
          });
          continue;
        }
        const asset = checksumEvmAddress(address);
        const known = lookupEvmToken(evmTokenTable, chainId, asset);
        changes.push({
          asset,
          amount: change.value.diff.toString(10),
          ...(known === undefined
            ? {
                ...unverifiedMetadata(change.token),
                verified: false,
              }
            : { decimals: known.decimals, symbol: known.symbol, verified: true }),
        });
      }
      return { status: "success", changes };
    }, setTimer);
  }

  async broadcast(client: PublicClient, raw: string): Promise<string> {
    return evmRpcHex(client, "eth_sendRawTransaction", [raw]);
  }

  /**
   * `eth_getTransactionReceipt` → `null` reads as no receipt (`undefined`); a malformed `blockHash`
   * (0x + 64 hex) or `blockNumber` throws — the poll fails and is retried rather than trusting a
   * half-answer.
   */
  async receipt(
    client: PublicClient,
    hash: string,
  ): Promise<
    | {
        readonly failed: boolean;
        readonly block: { readonly hash: string; readonly height: number };
      }
    | undefined
  > {
    const receipt: unknown = await evmRpc(client, "eth_getTransactionReceipt", [hash]);
    if (receipt === null) {
      return undefined;
    }
    const { blockHash, blockNumber, status } = isRecord(receipt) ? receipt : {};
    if (typeof status !== "string" || !/^0x[0-9a-fA-F]+$/.test(status)) {
      throw new TypeError("eth_getTransactionReceipt: malformed status");
    }
    return {
      failed: BigInt(status) === 0n,
      block: { hash: checkedBlockHash(blockHash), height: hexHeight(blockNumber) },
    };
  }

  /**
   * `eth_getBlockByNumber("finalized", false)` → the endpoint's finalized height; every built-in
   * network serves the tag, so a null or malformed answer is a `TypeError`, not a fallback.
   */
  async finalizedHeight(client: PublicClient): Promise<number> {
    const block: unknown = await evmRpc(client, "eth_getBlockByNumber", ["finalized", false]);
    return hexHeight(isRecord(block) ? block["number"] : undefined);
  }

  /**
   * `eth_getBlockByNumber(height, false)` → that block's hash; `null` (past the endpoint's head)
   * reads as `undefined`, a malformed block as a `TypeError`.
   */
  async blockHashAt(client: PublicClient, height: number): Promise<string | undefined> {
    const block: unknown = await evmRpc(client, "eth_getBlockByNumber", [hex(height), false]);
    if (block === null) {
      return undefined;
    }
    return checkedBlockHash(isRecord(block) ? block["hash"] : undefined);
  }
}
