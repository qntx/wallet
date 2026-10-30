import { ChainError } from "../index.ts";
import type { EvmTransaction, EvmAccessListEntry } from "../index.ts";
import { checksumEvmAddress, isEvmAddress } from "./address.ts";

/** Validates a string is `0x`-hex and narrows it to the branded hex type. */
export function assertHex(value: string, field: string): asserts value is `0x${string}` {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new ChainError("invalid-quantity", `${field} must be 0x-prefixed bytes`);
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CANONICAL_HEX = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

export const isCanonicalHex = (value: string): boolean => CANONICAL_HEX.test(value);

export const canonicalHex = (value: bigint): string => `0x${value.toString(16)}`;

const safeInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ChainError("invalid-quantity", `${field} must be a non-negative safe integer`);
  }
  return value;
};

const quantity = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new ChainError("invalid-quantity", `${field} must be a 0x quantity string`);
  }
  if (CANONICAL_HEX.test(value)) {
    return value;
  }
  if (/^0x[0-9a-fA-F]+$/.test(value) || value === "0x") {
    return canonicalHex(BigInt(value === "0x" ? "0x0" : value));
  }
  throw new ChainError("invalid-quantity", `${field} must be a 0x quantity`);
};

const hexBytes = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new ChainError("invalid-quantity", `${field} must be 0x-prefixed bytes`);
  }
  return value.toLowerCase();
};

const accessList = (value: unknown): ReadonlyArray<EvmAccessListEntry> => {
  if (!Array.isArray(value)) {
    throw new ChainError("invalid-request", "accessList must be an array");
  }
  return value.map((entry): EvmAccessListEntry => {
    if (!isRecord(entry)) {
      throw new ChainError("invalid-address", "accessList entries must be objects");
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "address" || keys[1] !== "storageKeys") {
      throw new ChainError(
        "unknown-field",
        `accessList entry fields must be exactly address+storageKeys, got ${keys.join(",")}`,
      );
    }
    const { address, storageKeys } = entry;
    if (typeof address !== "string" || !isEvmAddress(address)) {
      throw new ChainError("invalid-address", "accessList entry has an invalid address");
    }
    if (!Array.isArray(storageKeys)) {
      throw new ChainError("invalid-quantity", "accessList storageKeys must be an array");
    }
    return {
      address: checksumEvmAddress(address),
      storageKeys: storageKeys.map((k) => {
        if (typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k)) {
          throw new ChainError(
            "invalid-quantity",
            "accessList storageKeys must be 32-byte hex strings",
          );
        }
        return k.toLowerCase();
      }),
    };
  });
};

/** The EIP-155 part of a CAIP-2 `network` string, e.g. `eip155:1` → 1. */
export const networkChainId = (network: string): number => {
  const match = /^eip155:(\d+)$/.exec(network);
  const idPart = match?.[1];
  if (idPart === undefined) {
    throw new ChainError("chain-id-mismatch", `network is not an eip155 CAIP-2 id: ${network}`);
  }
  const id = Number(idPart);
  if (!Number.isSafeInteger(id)) {
    throw new ChainError("chain-id-mismatch", `chain id is not a safe integer: ${network}`);
  }
  return id;
};

const REQUIRED = {
  base: ["chainId", "nonce", "gas", "value", "data"],
  gasPrice: ["gasPrice"],
  accessList: ["accessList"],
  eip1559: ["maxFeePerGas", "maxPriorityFeePerGas"],
} as const;

const ALLOWED = {
  base: ["type", "chainId", "nonce", "gas", "value", "data", "to"],
  legacy: ["gasPrice"],
  eip2930: ["gasPrice", "accessList"],
  eip1559: ["accessList", "maxFeePerGas", "maxPriorityFeePerGas"],
} as const;

const requireFields = (input: Record<string, unknown>, fields: ReadonlyArray<string>): void => {
  for (const field of fields) {
    if (input[field] === undefined) {
      throw new ChainError("invalid-request", `tx.${field} is required`);
    }
  }
};

const rejectUnknown = (
  input: Record<string, unknown>,
  type: "legacy" | "eip2930" | "eip1559",
): void => {
  const allowed = new Set<string>([...ALLOWED.base, ...ALLOWED[type]]);
  const unknown = Object.keys(input).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new ChainError(
      "unknown-field",
      `tx has unknown fields for ${type}: ${unknown.sort().join(", ")}`,
    );
  }
};

/**
 * Canonicalizes an EVM transaction: exact key sets per type, all required fields present, `0x`
 * canonical quantities, EIP-55 addresses. Idempotent.
 */
export const normalizeEvmTransaction = (tx: unknown): EvmTransaction => {
  if (!isRecord(tx)) {
    throw new ChainError("invalid-request", "tx must be an object");
  }
  const { type } = tx;
  if (type !== "legacy" && type !== "eip2930" && type !== "eip1559") {
    throw new ChainError(
      "unsupported",
      `transaction type ${String(type)} is not supported (legacy, eip2930 and eip1559 only)`,
    );
  }
  rejectUnknown(tx, type);
  requireFields(tx, REQUIRED.base);
  const chainId = safeInteger(tx["chainId"], "chainId");
  const nonce = safeInteger(tx["nonce"], "nonce");
  const gas = quantity(tx["gas"], "gas");
  const value = quantity(tx["value"], "value");
  const data = hexBytes(tx["data"], "data");
  const toRaw = tx["to"];
  const to =
    toRaw === undefined
      ? undefined
      : typeof toRaw === "string" && isEvmAddress(toRaw)
        ? checksumEvmAddress(toRaw)
        : undefined;
  if (toRaw !== undefined && to === undefined) {
    throw new ChainError("invalid-address", "to must be a valid EVM address");
  }
  const base = { chainId, nonce, gas, value, data, ...(to === undefined ? {} : { to }) };
  if (type === "legacy") {
    requireFields(tx, REQUIRED.gasPrice);
    return { type, ...base, gasPrice: quantity(tx["gasPrice"], "gasPrice") };
  }
  if (type === "eip2930") {
    requireFields(tx, [...REQUIRED.gasPrice, ...REQUIRED.accessList]);
    return {
      type,
      ...base,
      gasPrice: quantity(tx["gasPrice"], "gasPrice"),
      accessList: accessList(tx["accessList"]),
    };
  }
  requireFields(tx, [...REQUIRED.accessList, ...REQUIRED.eip1559]);
  return {
    type,
    ...base,
    accessList: accessList(tx["accessList"]),
    maxFeePerGas: quantity(tx["maxFeePerGas"], "maxFeePerGas"),
    maxPriorityFeePerGas: quantity(tx["maxPriorityFeePerGas"], "maxPriorityFeePerGas"),
  };
};
