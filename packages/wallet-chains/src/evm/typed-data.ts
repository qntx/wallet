import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { isRecord } from "./transaction.ts";

type TypedDataField = {
  readonly name: string;
  readonly type: string;
};

/**
 * The subset of the EIP-712 document the wallet needs to see before handing it to ox's validator —
 * object with `types`, `primaryType`, `domain` and `message` of the right shapes.
 */
export type TypedDataInput = {
  readonly types: Record<string, ReadonlyArray<TypedDataField>>;
  readonly primaryType: string;
  readonly domain: Record<string, unknown>;
  readonly message: Record<string, unknown>;
};

const isField = (value: unknown): value is TypedDataField =>
  isRecord(value) && typeof value["name"] === "string" && typeof value["type"] === "string";

const isTypedDataInput = (value: unknown): value is TypedDataInput => {
  if (!isRecord(value)) {
    return false;
  }
  const { types, primaryType, domain, message } = value;
  if (!isRecord(types)) {
    return false;
  }
  if (typeof primaryType !== "string" || primaryType === "") {
    return false;
  }
  if (!isRecord(domain)) {
    return false;
  }
  if (!isRecord(message)) {
    return false;
  }
  return Object.values(types).every((fields) => Array.isArray(fields) && fields.every(isField));
};

export type ParsedTypedData = { readonly json: TypedDataInput };

/** A message object inside the document's `message`. */
export type TypedDataMessage = Readonly<Record<string, unknown>>;

export const isTypedDataMessage = (value: unknown): value is TypedDataMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` is an array of message objects (empty allowed). */
export const typedDataMessages = (value: unknown): ReadonlyArray<TypedDataMessage> | undefined =>
  Array.isArray(value) && value.every(isTypedDataMessage) ? value : undefined;

/** The `Type field,Type field` signature of struct `name` in `types`. */
export const typedDataSignature = (
  types: TypedDataInput["types"],
  name: string,
): string | undefined => types[name]?.map((field) => `${field.type} ${field.name}`).join(",");

/** Struct `name` has exactly `fields`, in order, no more. */
export const sameFields = (
  types: TypedDataInput["types"],
  name: string,
  fields: ReadonlyArray<string>,
): boolean => typedDataSignature(types, name) === fields.join(",");

/** A hex `address` field value, checksummed; `undefined` when malformed. */
export const typedDataAddress = (value: unknown): string | undefined =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? checksumEvmAddress(value)
    : undefined;

/** A uint field value (safe-integer number, decimal or `0x` hex string) ≤ `max`. */
export const typedDataUint = (value: unknown, max: bigint): bigint | undefined => {
  let parsed: bigint;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    return undefined;
  }
  return parsed >= 0n && parsed <= max ? parsed : undefined;
};

/** The largest timestamp a permit/order expiry or a Safe field is allowed to carry. */
export const MAX_UINT48: bigint = 2n ** 48n - 1n;

const isHexBytes = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);

/** A `bytes` field value: `0x`-prefixed hex of even length. */
export const typedDataBytes = (value: unknown): `0x${string}` | undefined =>
  isHexBytes(value) ? value : undefined;

/** Parses the EIP-712 JSON source and validates its shape with ox. */
export const parseTypedData = (typedData: string): ParsedTypedData => {
  let json: unknown;
  try {
    json = JSON.parse(typedData);
  } catch {
    throw new ChainError("invalid-typed-data", "typedData is not valid JSON");
  }
  if (!isTypedDataInput(json)) {
    throw new ChainError(
      "invalid-typed-data",
      "typedData must be a JSON object with types, primaryType, domain and message",
    );
  }
  try {
    TypedData.validate(json);
  } catch {
    throw new ChainError("invalid-typed-data", "typedData failed EIP-712 validation");
  }
  return { json };
};

/**
 * `domain.chainId` as a number, when present: a safe non-negative integer given as a JSON number, a
 * decimal string or a `0x` hex string.
 */
export const domainChainId = (domain: Record<string, unknown>): number | undefined => {
  const { chainId } = domain;
  if (chainId === undefined) {
    return undefined;
  }
  const numeric =
    typeof chainId === "number"
      ? chainId
      : typeof chainId === "string" && /^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(chainId)
        ? Number(chainId)
        : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ChainError("invalid-typed-data", "typed-data domain.chainId is malformed");
  }
  return numeric;
};
