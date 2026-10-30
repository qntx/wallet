import { ChainError } from "../index.ts";
import type { EvmTransaction, EvmAccessListEntry } from "../index.ts";
import { checksumEvmAddress, isEvmAddress } from "./address.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CANONICAL_HEX = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

export const isCanonicalHex = (value: string): boolean => CANONICAL_HEX.test(value);

export const canonicalHex = (value: bigint): string => `0x${value.toString(16)}`;

/** The exact key sets allowed per transaction type, minus `type` and `chainId`. */
const TX_FIELDS: Readonly<Record<EvmTransaction["type"], ReadonlySet<string>>> = {
  legacy: new Set(["to", "data", "value", "nonce", "gas", "gasPrice"]),
  eip2930: new Set(["to", "data", "value", "nonce", "gas", "gasPrice", "accessList"]),
  eip1559: new Set([
    "to",
    "data",
    "value",
    "nonce",
    "gas",
    "accessList",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
  ]),
};

const QUANTITY_FIELDS = new Set([
  "value",
  "gas",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
]);

const safeInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ChainError("invalid-quantity", `${field} must be a non-negative safe integer`);
  }
  return value;
};

const normalizeQuantity = (value: unknown, field: string): string => {
  if (typeof value === "string") {
    if (CANONICAL_HEX.test(value)) {
      return value;
    }
    // Accept a non-canonical hex form and canonicalize it (leading zeros, uppercase, `0x` alone).
    if (/^0x[0-9a-fA-F]+$/.test(value) || value === "0x") {
      return canonicalHex(BigInt(value === "0x" ? "0x0" : value));
    }
  }
  if (typeof value === "bigint") {
    return canonicalHex(value);
  }
  throw new ChainError("invalid-quantity", `${field} must be a canonical 0x quantity`);
};

const normalizeHexBytes = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new ChainError("invalid-quantity", `${field} must be 0x-prefixed bytes`);
  }
  return value.toLowerCase();
};

const normalizeAccessList = (value: unknown): ReadonlyArray<EvmAccessListEntry> => {
  if (!Array.isArray(value)) {
    throw new ChainError("unknown-field", "accessList must be an array");
  }
  return value.map((entry): EvmAccessListEntry => {
    if (typeof entry !== "object" || entry === null) {
      throw new ChainError("invalid-address", "accessList entries must be objects");
    }
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
    if (
      !Array.isArray(storageKeys) ||
      storageKeys.some((k) => typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k))
    ) {
      throw new ChainError(
        "invalid-quantity",
        "accessList storageKeys must be 32-byte hex strings",
      );
    }
    return {
      address: checksumEvmAddress(address),
      storageKeys: storageKeys.map((k) => String(k).toLowerCase()),
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

/**
 * Canonicalizes an EVM transaction: exact key sets per type, chainId must match the request's
 * `network` (checked by the caller), `0x` canonical quantities, EIP-55 addresses, sorted nothing —
 * the result is idempotent.
 */
export const normalizeEvmTransaction = (tx: EvmTransaction): EvmTransaction => {
  if (!isRecord(tx)) {
    throw new ChainError("invalid-request", "tx must be an object");
  }
  const input: Record<string, unknown> = tx;
  const { type } = input;
  if (type !== "legacy" && type !== "eip2930" && type !== "eip1559") {
    throw new ChainError(
      "unsupported",
      `transaction type ${String(type)} is not supported (legacy, eip2930 and eip1559 only)`,
    );
  }
  const allowed = TX_FIELDS[type];
  const unknown = Object.keys(input).filter(
    (k) => k !== "type" && k !== "chainId" && !allowed.has(k),
  );
  if (unknown.length > 0) {
    throw new ChainError(
      "unknown-field",
      `tx has unknown fields for ${type}: ${unknown.sort().join(", ")}`,
    );
  }
  const out: Record<string, unknown> = { type, chainId: safeInteger(input["chainId"], "chainId") };
  for (const key of allowed) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (key === "to") {
      if (typeof value !== "string" || !isEvmAddress(value)) {
        throw new ChainError("invalid-address", "to must be a valid EVM address");
      }
      out["to"] = checksumEvmAddress(value);
    } else if (key === "data") {
      out["data"] = normalizeHexBytes(value, "data");
    } else if (key === "nonce") {
      out["nonce"] = safeInteger(value, "nonce");
    } else if (key === "accessList") {
      out["accessList"] = normalizeAccessList(value);
    } else if (QUANTITY_FIELDS.has(key)) {
      out[key] = normalizeQuantity(value, key);
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every field was narrowed per the exact key set above
  return out as unknown as EvmTransaction;
};
