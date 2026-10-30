import { getCompiledTransactionMessageDecoder } from "@solana/transaction-messages";

import { ChainError } from "../index.ts";
import { isSolanaAddress } from "./ids.ts";

export const SOLANA_TRANSACTION_MAX_BYTES = 1232;

export type CompiledIx = {
  readonly programAddressIndex: number;
  readonly accountIndices: ReadonlyArray<number>;
  readonly data: Uint8Array;
};

export type ParsedSolanaMessage = {
  readonly version: "legacy" | 0;
  readonly numRequiredSignatures: number;
  readonly staticAccounts: ReadonlyArray<string>;
  readonly instructions: ReadonlyArray<CompiledIx>;
  readonly lookupCount: number;
  readonly lookupAddresses: ReadonlyArray<string>;
};

const decoder = getCompiledTransactionMessageDecoder();

/**
 * Decodes a compiled wire message; rejects trailing bytes and the 1232-byte transaction limit. The
 * fee payer is `staticAccounts[0]` — every valid transaction signs it.
 */
export const parseCompiledMessage = (bytes: Uint8Array): ParsedSolanaMessage => {
  if (bytes.length > SOLANA_TRANSACTION_MAX_BYTES) {
    throw new ChainError("invalid-request", "compiled message exceeds the 1232-byte limit");
  }
  if (bytes.length === 0) {
    throw new ChainError("invalid-request", "compiled message is empty");
  }
  let decoded: unknown;
  try {
    decoded = decoder.decode(bytes);
  } catch {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  const message = asCompiledMessage(decoded);
  const staticAccounts = [...message.staticAccounts];
  const lookups = message.addressTableLookups;
  return {
    version: message.version,
    numRequiredSignatures: message.numSignerAccounts,
    staticAccounts,
    instructions: message.instructions,
    lookupCount: lookups.length,
    lookupAddresses: lookups.map((l) => l.lookupTableAddress),
  };
};

type CompiledMessage = {
  readonly version: "legacy" | 0;
  readonly numSignerAccounts: number;
  readonly staticAccounts: ReadonlyArray<string>;
  readonly instructions: ReadonlyArray<CompiledIx>;
  readonly addressTableLookups: ReadonlyArray<{
    readonly lookupTableAddress: string;
    readonly readableIndices: ReadonlyArray<number>;
    readonly writableIndices: ReadonlyArray<number>;
  }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const isNumberArray = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) && value.every((v) => typeof v === "number");

const isArrayLike = (value: unknown): value is { readonly length: number } =>
  isRecord(value) && typeof value["length"] === "number";

const isIx = (value: unknown): value is CompiledIx =>
  isRecord(value) &&
  typeof value["programAddressIndex"] === "number" &&
  (value["accountIndices"] === undefined ||
    isNumberArray(value["accountIndices"]) ||
    isArrayLike(value["accountIndices"])) &&
  value["data"] instanceof Uint8Array;

const isLookup = (
  value: unknown,
): value is {
  lookupTableAddress: string;
  readableIndices: ReadonlyArray<number>;
  writableIndices: ReadonlyArray<number>;
} =>
  isRecord(value) &&
  typeof value["lookupTableAddress"] === "string" &&
  isNumberArray(value["readableIndices"]) &&
  isNumberArray(value["writableIndices"]);

const asCompiledMessage = (value: unknown): CompiledMessage => {
  if (!isRecord(value) || !isRecord(value["header"])) {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  const { header } = value;
  const { staticAccounts } = value;
  const { instructions } = value;
  const lookups = value["addressTableLookups"];
  if (
    typeof header["numSignerAccounts"] !== "number" ||
    !isStringArray(staticAccounts) ||
    !Array.isArray(instructions) ||
    !instructions.every(isIx) ||
    (lookups !== undefined && (!Array.isArray(lookups) || !lookups.every(isLookup)))
  ) {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  const version = value["version"] === 0 ? 0 : "legacy";
  const ixs = instructions.map((ix) => {
    if (!isIx(ix)) {
      throw new ChainError("invalid-request", "compiled message failed to decode");
    }
    const indices = ix.accountIndices;
    return {
      programAddressIndex: ix.programAddressIndex,
      accountIndices: indices === undefined ? [] : [...indices],
      data: ix.data,
    };
  });
  const tables = (lookups ?? []).map((t) => {
    if (!isLookup(t)) {
      throw new ChainError("invalid-request", "compiled message failed to decode");
    }
    return t;
  });
  return {
    version,
    numSignerAccounts: header["numSignerAccounts"],
    staticAccounts,
    instructions: ixs,
    addressTableLookups: tables,
  };
};

/**
 * Resolves an account index across static accounts and (request-declared) lookup tables in the
 * compiled lookup order: writable entries then readable.
 */
export const resolveAccountIndex = (
  parsed: ParsedSolanaMessage,
  index: number,
  lookups: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
): string | undefined => {
  if (index < parsed.staticAccounts.length) {
    return parsed.staticAccounts[index];
  }
  if (lookups === undefined) {
    return undefined;
  }
  let offset = index - parsed.staticAccounts.length;
  for (const table of lookups) {
    if (offset < table.addresses.length) {
      return table.addresses[offset];
    }
    offset -= table.addresses.length;
  }
  return undefined;
};

/** All declared lookup-table entries must be valid base58 32-byte addresses. */
export const validateLookupTables = (
  tables: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
): void => {
  if (tables === undefined) {
    return;
  }
  for (const table of tables) {
    if (!isSolanaAddress(table.address) || !table.addresses.every(isSolanaAddress)) {
      throw new ChainError(
        "invalid-address",
        "lookup table entries must be base58 32-byte addresses",
      );
    }
  }
};
