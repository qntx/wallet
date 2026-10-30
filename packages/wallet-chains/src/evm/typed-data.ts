import * as TypedData from "ox/TypedData";

import { ChainError } from "../index.ts";
import type { IntentWarning } from "../index.ts";
import { isRecord, networkChainId } from "./transaction.ts";

export type ParsedTypedData = {
  readonly json: Record<string, unknown>;
  /**
   * True when `domain.chainId` disagrees with the request's network — the intent is still signable
   * but must render `opaque` with a warning (never an error).
   */
  readonly chainIdMismatch: boolean;
};

/** Parses the EIP-712 JSON and validates its shape with ox. */
export const parseTypedData = (typedData: string, network: string): ParsedTypedData => {
  let json: unknown;
  try {
    json = JSON.parse(typedData);
  } catch {
    throw new ChainError("invalid-typed-data", "typedData is not valid JSON");
  }
  if (!isRecord(json)) {
    throw new ChainError("invalid-typed-data", "typedData must be a JSON object");
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a plain object above; ox validates the rest
    TypedData.validate(json as Parameters<typeof TypedData.validate>[0]);
  } catch {
    throw new ChainError("invalid-typed-data", "typedData failed EIP-712 validation");
  }
  const { domain } = json;
  let chainIdMismatch = false;
  if (isRecord(domain)) {
    const { chainId } = domain;
    const numeric =
      typeof chainId === "number"
        ? chainId
        : typeof chainId === "string"
          ? Number(chainId)
          : Number.NaN;
    if (Number.isSafeInteger(numeric) && numeric !== networkChainId(network)) {
      chainIdMismatch = true;
    }
  }
  return { json, chainIdMismatch };
};

export const typedDataWarnings = (parsed: ParsedTypedData): ReadonlyArray<IntentWarning> =>
  parsed.chainIdMismatch
    ? [
        {
          kind: "chain-id-mismatch",
          message: "typed-data domain.chainId does not match the request network",
        },
      ]
    : [];
