import * as TypedData from "ox/TypedData";

import { displayExcerpt, isEncodedBytes } from "../display.ts";
import { ChainError } from "../index.ts";
import type { TypedDataLeaf } from "../index.ts";
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

/** Struct nesting allowed in a message — real protocols (Seaport, Permit2, Safe) stay under 8. */
export const MAX_TYPED_DATA_DEPTH = 32;

/**
 * Walks `value` along `type`: every struct-typed value must be an object carrying its fields, and
 * struct/array nesting stays within MAX_TYPED_DATA_DEPTH — so a recursive type is bounded by its
 * message and a missing nested struct fails here rather than inside the encoder.
 */
const checkStructure = (
  types: TypedDataInput["types"],
  type: string,
  value: unknown,
  depth: number,
): void => {
  const array = /^(.+)\[\d*\]$/.exec(type);
  const struct = array === null ? types[type] : undefined;
  if (array === null && struct === undefined) {
    return;
  }
  if (depth >= MAX_TYPED_DATA_DEPTH) {
    throw new ChainError("invalid-typed-data", "typedData nests too deeply");
  }
  if (array !== null) {
    if (!Array.isArray(value)) {
      throw new ChainError("invalid-typed-data", `typedData ${type} value is not an array`);
    }
    for (const item of value) {
      checkStructure(types, array[1] ?? "", item, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    throw new ChainError("invalid-typed-data", `typedData ${type} value is not an object`);
  }
  for (const field of struct ?? []) {
    checkStructure(types, field.type, value[field.name], depth + 1);
  }
};

/**
 * Parses the EIP-712 JSON source and validates it with ox. `types.EIP712Domain` is required:
 * without it ox derives the domain type from the domain object while MetaMask hashes an empty
 * domain, so the same document would sign differently across wallets.
 */
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
  if (json.types["EIP712Domain"] === undefined) {
    throw new ChainError("invalid-typed-data", "typedData must declare types.EIP712Domain");
  }
  try {
    TypedData.validate(json);
  } catch {
    throw new ChainError("invalid-typed-data", "typedData failed EIP-712 validation");
  }
  checkStructure(json.types, json.primaryType, json.message, 0);
  /* Only the domain keys `types.EIP712Domain` declares are hashed — undeclared keys are
     dropped so nothing downstream (display, recognisers, the chain-id check, signing) can
     read a field the signature does not commit to. */
  const declared = new Set((json.types["EIP712Domain"] ?? []).map((field) => field.name));
  const domain = Object.fromEntries(
    Object.entries(json.domain).filter(([key]) => declared.has(key)),
  );
  return { json: { ...json, domain } };
};

/** Most leaves an unrecognised typed-data document may have and still be shown in full. */
export const TYPED_FIELD_BUDGET = 16;

/** Longest path or value (in code points, after sanitising) one leaf line may show. */
export const TYPED_FIELD_CODE_POINTS = 96;

const FIXED_BYTES = /^bytes(?:[1-9]|[12][0-9]|3[0-2])$/;
const INT_TYPE = /^u?int([0-9]*)$/;

/**
 * The display value of one atomic leaf, or `undefined` when the value is not in a form that is
 * shown exactly as it is encoded. Only the canonical forms every EIP-712 hasher agrees on are
 * accepted — anything else aborts the whole expansion.
 */
const leafValue = (type: string, value: unknown): string | undefined => {
  if (type === "address") {
    return typedDataAddress(value);
  }
  if (type === "bool") {
    return typeof value === "boolean" ? (value ? "true" : "false") : undefined;
  }
  if (type === "string") {
    if (typeof value !== "string") {
      return undefined;
    }
    const excerpt = displayExcerpt(value, 1, TYPED_FIELD_CODE_POINTS);
    return excerpt.omitted === 0 ? (excerpt.lines[0] ?? "") : undefined;
  }
  if (type === "bytes" || FIXED_BYTES.test(type)) {
    return typeof value === "string" &&
      /^0x([0-9a-fA-F]{2})*$/.test(value) &&
      value.length <= TYPED_FIELD_CODE_POINTS
      ? value.toLowerCase()
      : undefined;
  }
  const int = INT_TYPE.exec(type);
  if (int !== null) {
    const bits = int[1] === "" ? 256 : Number(int[1]);
    if (bits % 8 !== 0 || bits < 8 || bits > 256) {
      return undefined;
    }
    const signed = !type.startsWith("u");
    let parsed: bigint;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      parsed = BigInt(value);
    } else if (
      typeof value === "string" &&
      ((signed ? /^-?[0-9]+$/ : /^[0-9]+$/).test(value) || /^0x[0-9a-fA-F]+$/.test(value))
    ) {
      parsed = BigInt(value);
    } else {
      return undefined;
    }
    const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
    const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
    return parsed >= min && parsed <= max ? parsed.toString(10) : undefined;
  }
  return undefined;
};

/**
 * Whether the atomic leaf of `type` holding `value` is a commitment: `bytes`/`bytesN` always is —
 * the signature commits to raw bytes the owner cannot read — as is a `string` that is just an
 * encoded-bytes rendering of ≥ 32 bytes. An empty-array leaf ("[]") is not (it carries nothing).
 */
const isCommitmentLeaf = (type: string, value: unknown): boolean =>
  type === "bytes" ||
  FIXED_BYTES.test(type) ||
  (type === "string" && typeof value === "string" && isEncodedBytes(value));

/**
 * Every leaf of `message` under `primaryType`, in EIP-712 encoding order (each struct's fields in
 * declaration order, arrays element by element), as display lines, and whether every leaf is a
 * commitment; `undefined` when there are more than TYPED_FIELD_BUDGET leaves or any leaf cannot be
 * shown exactly as it is encoded. A document with no leaves is a vacuous commitment.
 */
export const typedDataFields = (
  json: TypedDataInput,
): { readonly fields: ReadonlyArray<TypedDataLeaf>; readonly commitment: boolean } | undefined => {
  const leaves: TypedDataLeaf[] = [];
  let commitment = true;
  const push = (path: string, value: string, commits: boolean): boolean => {
    const excerpt = displayExcerpt(path, 1, TYPED_FIELD_CODE_POINTS);
    if (excerpt.omitted !== 0) {
      return false;
    }
    leaves.push({ path: excerpt.lines[0] ?? "", value });
    commitment = commitment && commits;
    return leaves.length <= TYPED_FIELD_BUDGET;
  };
  const walk = (type: string, value: unknown, path: string): boolean => {
    const array = /^(.+)\[\d*\]$/.exec(type);
    if (array !== null) {
      if (!Array.isArray(value)) {
        return false;
      }
      return value.length === 0
        ? push(path, "[]", false)
        : value.every((item, index) => walk(array[1] ?? "", item, `${path}[${index}]`));
    }
    const struct = json.types[type];
    if (struct !== undefined) {
      return (
        isTypedDataMessage(value) &&
        struct.every((field) =>
          walk(field.type, value[field.name], path === "" ? field.name : `${path}.${field.name}`),
        )
      );
    }
    const leaf = leafValue(type, value);
    return leaf !== undefined && push(path, leaf, isCommitmentLeaf(type, value));
  };
  return walk(json.primaryType, json.message, "") ? { fields: leaves, commitment } : undefined;
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
