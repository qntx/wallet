/**
 * ERC-20 reads against a viem client. `balanceOf` calls go through the network's Multicall3 (one
 * `aggregate3` eth_call) when the registry declares it, otherwise one eth_call per token.
 * `symbol`/`decimals` are read on-chain only for tokens without a built-in-table entry.
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

/** A tracked token: `known` is its built-in-table entry — symbol/decimals/verified come from it. */
export type EvmTokenSpec = {
  readonly address: string;
  readonly known?: { readonly symbol: string; readonly decimals: number };
};

export type EvmTokenRead = {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: string;
  readonly verified: boolean;
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

export const balanceOfBatch = async (
  client: PublicClient,
  multicall3: string,
  owner: string,
  tokens: ReadonlyArray<string>,
): Promise<ReadonlyArray<bigint | undefined>> => {
  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [
      tokens.map((token) => ({
        target: checked(token),
        allowFailure: true,
        callData: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [checked(owner)],
        }),
      })),
    ],
  });
  const result = await evmRpcHex(client, "eth_call", [{ to: multicall3, data }, "latest"]);
  if (!isHex(result)) {
    throw new TypeError("eth_call returned malformed data");
  }
  const decoded = decodeFunctionResult({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    data: result,
  });
  return decoded.map((r) =>
    r.success
      ? decodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "balanceOf",
          data: r.returnData,
        })
      : undefined,
  );
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

/** Balances for every tracked token — one `aggregate3` when declared, else one call each. */
export const readEvmTokens = async (
  client: PublicClient,
  multicall3: string | undefined,
  owner: string,
  tokens: ReadonlyArray<EvmTokenSpec>,
): Promise<ReadonlyArray<EvmTokenRead>> => {
  if (tokens.length === 0) {
    return [];
  }
  const balances =
    multicall3 === undefined
      ? await Promise.all(tokens.map(async (t) => balanceOf(client, t.address, owner)))
      : await balanceOfBatch(
          client,
          multicall3,
          owner,
          tokens.map((t) => t.address),
        );
  return Promise.all(
    tokens.map(async (t, i) => ({
      address: t.address,
      symbol: t.known?.symbol ?? (await callToken(client, t.address, "symbol")) ?? "?",
      decimals: t.known?.decimals ?? (await callToken(client, t.address, "decimals")) ?? 18,
      balance: balances[i]?.toString() ?? "0",
      verified: t.known !== undefined,
    })),
  );
};
