/**
 * ERC-20 reads against a viem client. `balanceOf` and token `symbol`/`decimals` calls go through
 * the network's Multicall3 (one `aggregate3` eth_call per {@link MULTICALL_BATCH} calls) when the
 * registry declares it, otherwise one eth_call per token. A call that fails or does not decode is
 * `undefined` — nothing here ever invents a value.
 */
import { decodeFunctionResult, encodeFunctionData, isAddress, isHex } from "viem";
import type { PublicClient } from "viem";

import { ERC20_ABI, evmRpcHex } from "../chains/evm.ts";

export const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
    stateMutability: "payable",
  },
] as const;

/**
 * `aggregate3` calls are chunked at this size: the batch MetaMask uses, and comfortably inside the
 * gateway's request-body cap even at the largest token list the contract serves.
 */
export const MULTICALL_BATCH = 300;

/** The metadata one token needs from the chain: `decimals` always, `symbol` when asked. */
export type EvmMetadataWant = {
  readonly address: string;
  readonly symbol: boolean;
};

/** Chain-read token metadata; a field that could not be read is absent. */
export type EvmTokenMetadata = {
  readonly decimals?: number;
  readonly symbol?: string;
};

const checked = (v: string): `0x${string}` => {
  if (!isAddress(v)) {
    throw new TypeError(`malformed evm address: ${v}`);
  }
  return v;
};

export const balanceOf = async (
  client: PublicClient,
  token: string,
  owner: string,
): Promise<bigint | undefined> => {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [checked(owner)],
  });
  const result = await evmRpcHex(client, "eth_call", [{ to: token, data }, "latest"]);
  if (!isHex(result)) {
    throw new TypeError("eth_call returned malformed data");
  }
  return decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: result,
  });
};

export async function callToken(
  client: PublicClient,
  token: string,
  fn: "symbol",
): Promise<string | undefined>;
export async function callToken(
  client: PublicClient,
  token: string,
  fn: "decimals",
): Promise<number | undefined>;
export async function callToken(
  client: PublicClient,
  token: string,
  fn: "symbol" | "decimals",
): Promise<string | number | undefined> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: fn });
  const result = await evmRpcHex(client, "eth_call", [{ to: token, data }, "latest"]);
  if (!isHex(result)) {
    return undefined;
  }
  try {
    return decodeFunctionResult({ abi: ERC20_ABI, functionName: fn, data: result });
  } catch {
    return undefined;
  }
}

const batches = <T>(items: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MULTICALL_BATCH) {
    out.push(items.slice(i, i + MULTICALL_BATCH));
  }
  return out;
};

/** The multicall path of an `aggregate3`-batched ERC-20 read: one eth_call per batch of 300. */
const aggregate = async (
  client: PublicClient,
  multicall3: string,
  calls: ReadonlyArray<{ readonly target: `0x${string}`; readonly callData: `0x${string}` }>,
): Promise<ReadonlyArray<`0x${string}` | undefined>> => {
  const results = await Promise.all(
    batches(calls).map(async (part) => {
      const data = encodeFunctionData({
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [part.map((call) => ({ ...call, allowFailure: true }))],
      });
      const result = await evmRpcHex(client, "eth_call", [{ to: multicall3, data }, "latest"]);
      if (!isHex(result)) {
        throw new TypeError("eth_call returned malformed data");
      }
      return decodeFunctionResult({
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        data: result,
      });
    }),
  );
  return results
    .flat()
    .map((r) => (r.success ? (isHex(r.returnData) ? r.returnData : undefined) : undefined));
};

/**
 * `balanceOf(owner)` for every address, in the given order. One `aggregate3` eth_call per 300
 * tokens when `multicall3` is declared, else one eth_call per token; a failing batched call is
 * `undefined`.
 */
export const readEvmBalances = async (
  client: PublicClient,
  multicall3: string | undefined,
  owner: string,
  addresses: ReadonlyArray<string>,
): Promise<ReadonlyArray<bigint | undefined>> => {
  if (multicall3 === undefined) {
    return Promise.all(addresses.map(async (token) => balanceOf(client, token, owner)));
  }
  const results = await aggregate(
    client,
    multicall3,
    addresses.map((token) => ({
      target: checked(token),
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [checked(owner)],
      }),
    })),
  );
  return results.map((data) => {
    if (data === undefined) {
      return undefined;
    }
    try {
      return decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data });
    } catch {
      return undefined;
    }
  });
};

/**
 * The requested metadata for every address, in the given order — `decimals` for each and `symbol`
 * for the ones that asked, all batched into `aggregate3` calls of at most 300 when `multicall3` is
 * declared. A field that could not be read is absent; nothing is defaulted.
 */
export const readEvmMetadata = async (
  client: PublicClient,
  multicall3: string | undefined,
  wants: ReadonlyArray<EvmMetadataWant>,
): Promise<ReadonlyArray<EvmTokenMetadata>> => {
  if (multicall3 === undefined) {
    return Promise.all(
      wants.map(async (want) => {
        const decimals = await callToken(client, want.address, "decimals");
        const symbol = want.symbol ? await callToken(client, want.address, "symbol") : undefined;
        return {
          ...(decimals === undefined ? {} : { decimals }),
          ...(symbol === undefined ? {} : { symbol }),
        };
      }),
    );
  }
  const calls = wants.flatMap((want, index) => {
    const fns: ReadonlyArray<"decimals" | "symbol"> = want.symbol
      ? ["decimals", "symbol"]
      : ["decimals"];
    return fns.map((fn) => ({
      index,
      fn,
      target: checked(want.address),
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: fn }),
    }));
  });
  const results = await aggregate(client, multicall3, calls);
  const metas: EvmTokenMetadata[] = wants.map(() => ({}));
  for (const [i, data] of results.entries()) {
    const call = calls[i];
    if (call === undefined || data === undefined) {
      continue;
    }
    try {
      const value = decodeFunctionResult({ abi: ERC20_ABI, functionName: call.fn, data });
      const current = metas[call.index] ?? {};
      if (call.fn === "decimals" && typeof value === "number") {
        metas[call.index] = { ...current, decimals: value };
      } else if (call.fn === "symbol" && typeof value === "string") {
        metas[call.index] = { ...current, symbol: value };
      }
    } catch {
      // An undecodable answer stays absent — the field is simply unknown.
    }
  }
  return metas;
};
