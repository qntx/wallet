import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as AbiFunction from "ox/AbiFunction";

import type { ApprovalChange, AssetAmount, AssetFlow, DisplayIntent } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { MAX_UINT256, allowanceChange } from "./approval.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { lookupEvmToken } from "./tokens.ts";
import { assertHex } from "./transaction.ts";

/**
 * The 0x AllowanceHolder (`exec`) is deployed at the same address on every chain the taker Settler
 * supports. `exec` grants the caller a one-time allowance of `amount` of `token` to `operator`,
 * then calls `target` with `data` (forwarding `msg.value`).
 */
export const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";

/** Chains whose AllowanceHolder + Settler deployment this decoder recognises. */
export const ZEROX_CHAINS: ReadonlySet<number> = new Set([
  1, 10, 56, 137, 8453, 999, 42161, 43114, 11155111,
]);

const ZEROX_DEPLOYER = "0x00000000000004533Fe15556B1E086BB1A72cEae";
const SHIM_INIT_CODE_HASH = "0x3bf3f97f0be1e2c00023033eefeb4fc062ac552ff36778b17060d90b6764902f";

/** The native-token sentinel 0x uses in `exec`, and the bare zero address (same meaning). */
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const EXEC: AbiFunction.AbiFunction = AbiFunction.from(
  "function exec(address operator, address token, uint256 amount, address payable target, bytes data)",
);
const SETTLER_EXECUTE: AbiFunction.AbiFunction = AbiFunction.from(
  "function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid)",
);

const last20 = (hex: string): string => `0x${hex.slice(-40)}`;

const addressBytes = (address: string): Uint8Array => hexToBytes(address.slice(2));

const bigIntBytes32 = (value: bigint): Uint8Array =>
  hexToBytes(value.toString(16).padStart(64, "0"));

const keccakHex = (parts: ReadonlyArray<Uint8Array>): string => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const flat = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    flat.set(part, offset);
    offset += part.length;
  }
  return `0x${bytesToHex(keccak_256(flat))}`;
};

const FEATURE_TAKER = 2n;

/**
 * Whether `address` is a taker-feature (2) 0x Settler on `chainId`. Settlers deploy as a CREATE2
 * shim whose CREATE child is the contract: `salt = (feature << 128) | (chainId << 64) | nonce`,
 * `shim = CREATE2(deployer, salt, initHash)`, `settler = CREATE(shim, 1)`. Settler is redeployed
 * roughly monthly, so nonces 1..256 leave decades of headroom; the loop runs 512 keccaks and is
 * only reached for an AllowanceHolder `exec`. Feature 5 (bridge) is deliberately not matched.
 */
export const isZeroExSettler = (chainId: number, address: string): boolean => {
  const want = address.toLowerCase();
  const deployer = addressBytes(ZEROX_DEPLOYER);
  const initHash = hexToBytes(SHIM_INIT_CODE_HASH.slice(2));
  for (let nonce = 1; nonce <= 256; nonce++) {
    const salt = bigIntBytes32(
      FEATURE_TAKER * 2n ** 128n + BigInt(chainId) * 2n ** 64n + BigInt(nonce),
    );
    const shim = addressBytes(
      last20(keccakHex([new Uint8Array([0xff]), deployer, salt, initHash])),
    );
    const settler = last20(keccakHex([new Uint8Array([0xd6, 0x94]), shim, new Uint8Array([0x01])]));
    if (settler === want) {
      return true;
    }
  }
  return false;
};

type ExecArgs = {
  readonly operator: string;
  readonly token: string;
  readonly amount: bigint;
  readonly target: string;
  readonly data: string;
};

/** The canonical-decoded `exec` arguments, or `undefined` (selector mismatch or non-canonical). */
const decodeExec = (data: string): ExecArgs | undefined => {
  if (!data.toLowerCase().startsWith("0x2213bc0b")) {
    return undefined;
  }
  try {
    assertHex(data, "data");
    const args: unknown = AbiFunction.decodeData(EXEC, data);
    if (!Array.isArray(args) || args.length !== 5) {
      return undefined;
    }
    const reencoded = AbiFunction.encodeData(EXEC, args);
    if (reencoded.toLowerCase() !== data.toLowerCase()) {
      return undefined;
    }
    const list: ReadonlyArray<unknown> = args;
    const [operator, token, amount, target, inner] = list;
    if (
      typeof operator !== "string" ||
      typeof token !== "string" ||
      typeof amount !== "bigint" ||
      typeof target !== "string" ||
      typeof inner !== "string"
    ) {
      return undefined;
    }
    return { operator, token, amount, target, data: inner };
  } catch {
    return undefined;
  }
};

type SettlerSlippage = {
  readonly recipient: string;
  readonly buyToken: string;
  readonly minAmountOut: bigint;
};

const isSlippage = (value: unknown): value is SettlerSlippage =>
  typeof value === "object" &&
  value !== null &&
  "recipient" in value &&
  typeof value.recipient === "string" &&
  "buyToken" in value &&
  typeof value.buyToken === "string" &&
  "minAmountOut" in value &&
  typeof value.minAmountOut === "bigint";

/**
 * The canonical-decoded `execute` slippage tuple, or `undefined` when the call is not a Settler
 * execute.
 */
const decodeSettlerExecute = (data: string): SettlerSlippage | undefined => {
  if (!data.toLowerCase().startsWith("0x1fff991f")) {
    return undefined;
  }
  try {
    assertHex(data, "data");
    const args: unknown = AbiFunction.decodeData(SETTLER_EXECUTE, data);
    if (!Array.isArray(args) || args.length !== 3) {
      return undefined;
    }
    const reencoded = AbiFunction.encodeData(SETTLER_EXECUTE, args);
    if (reencoded.toLowerCase() !== data.toLowerCase()) {
      return undefined;
    }
    const list: ReadonlyArray<unknown> = args;
    const [slippage] = list;
    if (!isSlippage(slippage)) {
      return undefined;
    }
    return slippage;
  } catch {
    return undefined;
  }
};

const isNativeToken = (token: string): boolean =>
  token.toLowerCase() === NATIVE_SENTINEL || token.toLowerCase() === ZERO_ADDRESS;

const tokenAmount = (
  token: string,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
): AssetAmount => {
  const known = lookupEvmToken(table, chainId, token);
  return {
    asset: checksumEvmAddress(token),
    amount: amount.toString(10),
    ...(known === undefined ? {} : { symbol: known.symbol, decimals: known.decimals }),
  };
};

const nativeMinimum = (amount: bigint): AssetAmount => ({
  asset: EVM_NATIVE_ASSET,
  amount: amount.toString(10),
});

/**
 * The `DisplayIntent` for a call to AllowanceHolder `exec` on a chain this decoder covers: a swap
 * when the operator calls the taker Settler's own `execute` (operator == target, an on-chain
 * Settler, a canonical inner call) and a generic one-time allowance otherwise. `undefined` when the
 * call is not to AllowanceHolder or not `exec`.
 */
export const decodeZeroX = (
  chainId: number,
  call: { readonly to: string | undefined; readonly value: bigint; readonly data: string },
  table: EvmTokenTable,
):
  | (Pick<DisplayIntent, "summary" | "outflows" | "approvals" | "verifiability"> & {
      readonly minimumReceived?: DisplayIntent["minimumReceived"];
    })
  | undefined => {
  if (
    call.to === undefined ||
    call.to.toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase() ||
    !ZEROX_CHAINS.has(chainId)
  ) {
    return undefined;
  }
  const exec = decodeExec(call.data);
  if (exec === undefined) {
    return undefined;
  }
  const { operator, token, amount, target, data: inner } = exec;

  const slippage = decodeSettlerExecute(inner);
  const isSettlerSwap =
    operator.toLowerCase() === target.toLowerCase() &&
    isZeroExSettler(chainId, target) &&
    slippage !== undefined;

  if (isSettlerSwap && slippage !== undefined) {
    let outflow: AssetFlow | undefined;
    if (isNativeToken(token)) {
      /* A native sell must forward exactly `amount` as `msg.value`. */
      if (amount === call.value && call.value > 0n) {
        outflow = {
          to: target,
          amount: { asset: EVM_NATIVE_ASSET, amount: call.value.toString(10) },
          verified: true,
        };
      }
    } else if (call.value === 0n) {
      outflow = {
        to: target,
        amount: tokenAmount(token, amount, chainId, table),
        verified: lookupEvmToken(table, chainId, token) !== undefined,
      };
    }
    if (outflow !== undefined) {
      const buyNative = isNativeToken(slippage.buyToken);
      return {
        summary: "swap",
        outflows: [outflow],
        approvals: [],
        minimumReceived: [
          {
            to: slippage.recipient,
            amount: buyNative
              ? nativeMinimum(slippage.minAmountOut)
              : tokenAmount(slippage.buyToken, slippage.minAmountOut, chainId, table),
          },
        ],
        verifiability: "partial",
      };
    }
  }

  const approvals: ApprovalChange[] = isNativeToken(token)
    ? []
    : [
        allowanceChange(
          checksumEvmAddress(token),
          operator,
          amount,
          "transfer",
          MAX_UINT256,
          chainId,
          table,
          { via: "allowance-holder" },
        ),
      ];
  const outflows: ReadonlyArray<AssetFlow> =
    call.value === 0n
      ? []
      : [
          {
            to: target,
            amount: { asset: EVM_NATIVE_ASSET, amount: call.value.toString(10) },
            verified: true,
          },
        ];
  return {
    summary: "contract-call",
    outflows,
    approvals,
    verifiability: "partial",
  };
};
