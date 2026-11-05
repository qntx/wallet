/**
 * Recognition of Safe `SafeTx` typed data. A document is recognized only when the primary type is
 * `SafeTx` with exactly the canonical field list and the domain names a `verifyingContract` (the
 * Safe); any other shape stays an opaque message. A `delegatecall` to a canonical MultiSendCallOnly
 * contract is unpacked into its inner calls; anything else stays a single opaque call.
 */
import * as AbiFunction from "ox/AbiFunction";

import type { DisplayIntent, SafeTransaction } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { MAX_UINT256 } from "./approval.ts";
import { sameFields, typedDataAddress, typedDataBytes, typedDataUint } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

/**
 * Canonical MultiSendCallOnly deployments (safe-global/safe-deployments): 1.3.0, the 1.3.0 eip155
 * variant and 1.4.1, lowercase for a checksum-insensitive compare.
 */
export const SAFE_MULTISEND_CALL_ONLY: ReadonlySet<string> = new Set([
  "0x40a2accbd92bca938b02010e17a5b8929b49130d",
  "0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b",
  "0x9641d764fc13c8b624c04430c7356c1c7c8102e2",
]);

const SAFE_TX = [
  "address to",
  "uint256 value",
  "bytes data",
  "uint8 operation",
  "uint256 safeTxGas",
  "uint256 baseGas",
  "uint256 gasPrice",
  "address gasToken",
  "address refundReceiver",
  "uint256 nonce",
];

const MULTISEND = AbiFunction.from("function multiSend(bytes transactions)");

type Call = {
  readonly to: string | undefined;
  readonly value: bigint;
  readonly data: `0x${string}`;
};

export type SafeRecognition = {
  readonly safe: SafeTransaction;
  /** `data` decoded as `multiSend(bytes)` and unpacked; the intent's summary is `batch`. */
  readonly multisend: boolean;
};

/**
 * Packed MultiSend entries (`uint8 operation, address to, uint256 value, uint256 dataLength, bytes
 * data` repeated). `undefined` when `data` is not a `multiSend(bytes)` call, a byte is truncated or
 * trailing, or an entry's operation is not 0 — the caller falls back to one opaque call.
 */
const multiSendEntries = (data: `0x${string}`): ReadonlyArray<Call> | undefined => {
  if (!data.toLowerCase().startsWith("0x8d80ff0a")) {
    return undefined;
  }
  let packed: string;
  try {
    const decoded: unknown = AbiFunction.decodeData(MULTISEND, data);
    const first: unknown = Array.isArray(decoded) ? decoded[0] : undefined;
    if (typeof first !== "string") {
      return undefined;
    }
    packed = first;
  } catch {
    return undefined;
  }
  if (!packed.startsWith("0x")) {
    return undefined;
  }
  const hex = packed.slice(2).toLowerCase();
  const calls: Call[] = [];
  let offset = 0;
  while (offset < hex.length) {
    if (hex.length - offset < 170) {
      return undefined;
    }
    const operation = Number.parseInt(hex.slice(offset, offset + 2), 16);
    if (operation !== 0) {
      return undefined;
    }
    const to = `0x${hex.slice(offset + 2, offset + 42)}`;
    const value = BigInt(`0x${hex.slice(offset + 42, offset + 106)}`);
    const length = BigInt(`0x${hex.slice(offset + 106, offset + 170)}`);
    offset += 170;
    if (length * 2n > BigInt(hex.length - offset)) {
      return undefined;
    }
    calls.push({
      to: checksumEvmAddress(to),
      value,
      data: `0x${hex.slice(offset, offset + Number(length) * 2)}`,
    });
    offset += Number(length) * 2;
  }
  return calls;
};

/**
 * The Safe transaction a typed-data document signs, or `undefined` when its shape is not exactly
 * the recognized one. `decode` decodes one inner call (the transaction rules without a fee); the
 * caller injects it bound to the request's network and token table.
 */
export function recognizeSafe(
  json: TypedDataInput,
  decode: (call: Call) => DisplayIntent,
): SafeRecognition | undefined {
  const { types, primaryType, message, domain } = json;
  if (primaryType !== "SafeTx" || !sameFields(types, "SafeTx", SAFE_TX)) {
    return undefined;
  }
  const safe = typedDataAddress(domain["verifyingContract"]);
  const to = typedDataAddress(message["to"]);
  const value = typedDataUint(message["value"], MAX_UINT256);
  const data = typedDataBytes(message["data"]);
  const operation = typedDataUint(message["operation"], 255n);
  const safeTxGas = typedDataUint(message["safeTxGas"], MAX_UINT256);
  const baseGas = typedDataUint(message["baseGas"], MAX_UINT256);
  const gasPrice = typedDataUint(message["gasPrice"], MAX_UINT256);
  const gasToken = typedDataAddress(message["gasToken"]);
  const refundReceiver = typedDataAddress(message["refundReceiver"]);
  const nonce = typedDataUint(message["nonce"], MAX_UINT256);
  if (
    safe === undefined ||
    to === undefined ||
    value === undefined ||
    data === undefined ||
    operation === undefined ||
    operation > 1n ||
    safeTxGas === undefined ||
    baseGas === undefined ||
    gasPrice === undefined ||
    gasToken === undefined ||
    refundReceiver === undefined ||
    nonce === undefined
  ) {
    return undefined;
  }
  const inner =
    operation === 1n && SAFE_MULTISEND_CALL_ONLY.has(to.toLowerCase())
      ? multiSendEntries(data)
      : undefined;
  const calls = (inner ?? [{ to, value, data }]).map(decode);
  return {
    safe: {
      safe,
      nonce: nonce.toString(10),
      operation: operation === 0n ? "call" : "delegatecall",
      to,
      value: value.toString(10),
      data,
      calls,
      ...(gasPrice > 0n
        ? {
            refund: {
              gasPrice: gasPrice.toString(10),
              gasToken,
              refundReceiver,
            },
          }
        : {}),
    },
    multisend: inner !== undefined,
  };
}
