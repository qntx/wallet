import * as Hex from "ox/Hex";
import * as TypedData from "ox/TypedData";

import { displayExcerpt, hasHiddenCharacters, isEncodedBytes } from "../display.ts";
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

export const isTypedDataInput = (value: unknown): value is TypedDataInput => {
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

/**
 * The EIP-712 domain separator and message struct hash of a parsed document — the same encoder
 * `planEvmTypedData` signs (`keccak256(0x1901 | domain | message)` is the task digest). `message`
 * is `undefined` when the primary type is `EIP712Domain` itself.
 */
export const typedDataHashes = (
  json: TypedDataInput,
): { readonly domain: Uint8Array; readonly message: Uint8Array | undefined } => {
  // ox encodes `0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(message)`; the struct hash is absent
  // when the primary type is EIP712Domain itself.
  const encoded = Hex.toBytes(
    TypedData.encode({
      domain: json.domain,
      types: json.types,
      primaryType: json.primaryType,
      message: json.message,
    }),
  );
  return {
    domain: encoded.subarray(2, 34),
    message: json.primaryType === "EIP712Domain" ? undefined : encoded.subarray(34),
  };
};

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
  typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);

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
 * Whether the atomic leaf of `type` holding `value` is a commitment: `bytesN` always is — the
 * signature commits to raw bytes the owner cannot read — as is a non-empty `bytes` or a `string`
 * that is just an encoded-bytes rendering of ≥ 32 bytes. `"0x"` and an empty-array leaf ("[]")
 * carry nothing and are not.
 */
const isCommitmentLeaf = (type: string, value: unknown): boolean =>
  (type === "bytes" && value !== "0x") ||
  FIXED_BYTES.test(type) ||
  (type === "string" && typeof value === "string" && isEncodedBytes(value));

/**
 * Every leaf of `message` under `primaryType`, in EIP-712 encoding order (each struct's fields in
 * declaration order, arrays element by element), as display lines, and whether any leaf is a
 * commitment; `undefined` when there are more than TYPED_FIELD_BUDGET leaves or any leaf cannot be
 * shown exactly as it is encoded. `leaf` may override an atomic leaf's display — a string return is
 * used verbatim (commitment flags still apply) and `undefined` falls back to the default rule,
 * which aborts the expansion when it cannot show the leaf exactly.
 */
export const typedDataFields = (
  json: TypedDataInput,
  leaf?: (type: string, value: unknown) => string | undefined,
):
  | { readonly fields: ReadonlyArray<TypedDataLeaf>; readonly hasCommitment: boolean }
  | undefined => {
  const leaves: TypedDataLeaf[] = [];
  let hasCommitment = false;
  const push = (path: string, value: string, commits: boolean): boolean => {
    const excerpt = displayExcerpt(path, 1, TYPED_FIELD_CODE_POINTS);
    if (excerpt.omitted !== 0) {
      return false;
    }
    leaves.push({ path: excerpt.lines[0] ?? "", value });
    hasCommitment = hasCommitment || commits;
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
    const display = leaf?.(type, value) ?? leafValue(type, value);
    return display !== undefined && push(path, display, isCommitmentLeaf(type, value));
  };
  return walk(json.primaryType, json.message, "") ? { fields: leaves, hasCommitment } : undefined;
};

/**
 * Whether any `string` leaf of the document carries characters the text rule hides — domain fields
 * under `types.EIP712Domain` (or the fields ox derives when it is not declared) and message fields
 * under `primaryType`, walked through structs and arrays — or the type encoding's own strings do:
 * `primaryType`, every key of `types`, and every field's `name` and `type` are hashed into the
 * signature, so a deceptive code point there is blind for the same reason as hidden message bytes.
 * All declared types are scanned, not only the ones the primary type reaches. A key the type does
 * not declare is not signed and is ignored. Never throws: a branch it cannot walk counts as no
 * hidden text — malformed documents are refused by the validator.
 */
export const typedDataHasHiddenText = (json: TypedDataInput): boolean => {
  const hidden = (type: string, value: unknown, depth: number): boolean => {
    if (depth >= MAX_TYPED_DATA_DEPTH) {
      return false;
    }
    const array = /^(.+)\[\d*\]$/.exec(type);
    if (array !== null) {
      return Array.isArray(value) && value.some((item) => hidden(array[1] ?? "", item, depth + 1));
    }
    const struct = json.types[type];
    if (struct !== undefined) {
      return (
        isRecord(value) && struct.some((field) => hidden(field.type, value[field.name], depth + 1))
      );
    }
    return type === "string" && typeof value === "string" && hasHiddenCharacters(value);
  };
  const domainFields =
    json.types["EIP712Domain"] ?? TypedData.extractEip712DomainTypes(json.domain);
  const namesHidden =
    hasHiddenCharacters(json.primaryType) ||
    Object.entries(json.types).some(
      ([name, struct]) =>
        hasHiddenCharacters(name) ||
        struct.some((field) => hasHiddenCharacters(field.name) || hasHiddenCharacters(field.type)),
    ) ||
    domainFields.some(
      (field) => hasHiddenCharacters(field.name) || hasHiddenCharacters(field.type),
    );
  return (
    namesHidden ||
    domainFields.some((field) => hidden(field.type, json.domain[field.name], 0)) ||
    hidden(json.primaryType, json.message, 0)
  );
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
