import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
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
