import * as AbiFunction from "ox/AbiFunction";

import { ChainError } from "../index.ts";
import type { AssetAmount, AssetFlow, StakeAction } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { lookupEvmToken } from "./tokens.ts";
import { assertHex } from "./transaction.ts";

/** The Lido contracts the kernel recognises by address — Ethereum mainnet only. */
export const LIDO_CHAIN = 1;
export const LIDO_STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
export const LIDO_WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
export const LIDO_QUEUE = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";

const SUBMIT = AbiFunction.from("function submit(address referral) payable");
const REQUEST = AbiFunction.from("function requestWithdrawals(uint256[] amounts, address owner)");
const REQUEST_WSTETH = AbiFunction.from(
  "function requestWithdrawalsWstETH(uint256[] amounts, address owner)",
);
const REQUEST_PERMIT = AbiFunction.from(
  "function requestWithdrawalsWithPermit(uint256[] amounts, address owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit)",
);
const REQUEST_WSTETH_PERMIT = AbiFunction.from(
  "function requestWithdrawalsWstETHWithPermit(uint256[] amounts, address owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit)",
);
const CLAIM = AbiFunction.from("function claimWithdrawals(uint256[] requestIds, uint256[] hints)");

const ZERO = "0x0000000000000000000000000000000000000000";

/** Canonical-encoding decode like `tryCall` in decode.ts — undefined on any mismatch. */
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

const argAddress = (args: ReadonlyArray<unknown>, index: number): string => {
  const value = args[index];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ChainError("invalid-request", "decoded argument is not an address");
  }
  return checksumEvmAddress(value);
};

const argList = (args: ReadonlyArray<unknown>, index: number): ReadonlyArray<bigint> => {
  const value = args[index];
  if (!Array.isArray(value) || !value.every((v): v is bigint => typeof v === "bigint")) {
    throw new ChainError("invalid-request", "decoded argument is not a uint256 array");
  }
  return value;
};

const tokenAmount = (token: string, amount: bigint, table: EvmTokenTable): AssetAmount => {
  const known = lookupEvmToken(table, LIDO_CHAIN, token);
  return {
    asset: token,
    amount: amount.toString(10),
    ...(known === undefined ? {} : { symbol: known.symbol, decimals: known.decimals }),
  };
};

const tokenFlow = (token: string, to: string, amount: bigint, table: EvmTokenTable): AssetFlow => ({
  to,
  amount: tokenAmount(token, amount, table),
  verified: lookupEvmToken(table, LIDO_CHAIN, token) !== undefined,
});

export type LidoDecode = {
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly staking: ReadonlyArray<StakeAction>;
};

/**
 * Lido staking on Ethereum mainnet: `submit` to stETH, the four withdrawal-request forms and
 * `claimWithdrawals` on the queue. The minted stETH shares and the checkpointed claim amounts
 * cannot be read exactly from calldata, so every recognised call is verifiability-partial.
 */
export const decodeLido = (
  chainId: number,
  call: { readonly to: string | undefined; readonly value: bigint; readonly data: string },
  signer: string,
  table: EvmTokenTable,
): LidoDecode | undefined => {
  if (chainId !== LIDO_CHAIN || call.to === undefined) {
    return undefined;
  }
  const to = call.to.toLowerCase();
  if (to === LIDO_STETH.toLowerCase() && call.value > 0n) {
    if (tryCall(SUBMIT, call.data) !== undefined) {
      return {
        outflows: [
          {
            to: LIDO_STETH,
            amount: { asset: EVM_NATIVE_ASSET, amount: call.value.toString(10) },
            verified: true,
          },
        ],
        staking: [
          {
            kind: "lido-submit",
            amount: { asset: EVM_NATIVE_ASSET, amount: call.value.toString(10) },
            receive: tokenAmount(LIDO_STETH, call.value, table),
          },
        ],
      };
    }
    return undefined;
  }
  if (to !== LIDO_QUEUE.toLowerCase()) {
    return undefined;
  }
  for (const [fn, token] of [
    [REQUEST, LIDO_STETH],
    [REQUEST_WSTETH, LIDO_WSTETH],
    [REQUEST_PERMIT, LIDO_STETH],
    [REQUEST_WSTETH_PERMIT, LIDO_WSTETH],
  ] as const) {
    const args = tryCall(fn, call.data);
    if (args === undefined) {
      continue;
    }
    const total = argList(args, 0).reduce((sum, amount) => sum + amount, 0n);
    /* The queue treats a zero owner as the caller. */
    const raw = argAddress(args, 1);
    const owner = raw === ZERO ? signer : raw;
    const action: StakeAction = {
      kind: "lido-request",
      token,
      amount: tokenAmount(token, total, table),
      owner,
    };
    return {
      outflows:
        owner.toLowerCase() === signer.toLowerCase() ? [] : [tokenFlow(token, owner, total, table)],
      staking: [action],
    };
  }
  const claimArgs = tryCall(CLAIM, call.data);
  if (claimArgs !== undefined) {
    const requestIds = argList(claimArgs, 0).map((id) => id.toString(10));
    argList(claimArgs, 1);
    return { outflows: [], staking: [{ kind: "lido-claim", requestIds }] };
  }
  return undefined;
};
