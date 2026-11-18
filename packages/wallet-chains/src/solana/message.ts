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
  readonly lookups: ReadonlyArray<LookupReference>;
};

/** One address-table lookup: the table and which of its entries the message references. */
export type LookupReference = {
  readonly address: string;
  readonly writableIndexes: ReadonlyArray<number>;
  readonly readonlyIndexes: ReadonlyArray<number>;
};

const decoder = getCompiledTransactionMessageDecoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Whether a cluster could accept `bytes` as the message of a transaction — signing them as a raw
 * message would authorise it.
 */
export const mayBeTransactionMessage = (bytes: Uint8Array): boolean => {
  const [first] = bytes;
  // solana-message 6.0.0 src/versions/mod.rs: a first byte with the high bit set opens a versioned
  // message (version = byte & 0x7f), and Agave refuses version 127 as a transaction because 0xff
  // opens off-chain messages.
  if (first === undefined || first === 0xff) {
    return false;
  }
  if (first >= 0x80) {
    /* UTF-8 never starts with 0x80–0xc1 or 0xf5–0xfe, so only non-ASCII text (lead bytes
       0xc2–0xf4, versions 66–116 — none exist) may pass: text is what the prompt shows. */
    try {
      utf8.decode(bytes);
      return false;
    } catch {
      return true;
    }
  }
  /* A first byte below 0x80 is a legacy header's numRequiredSignatures; refuse any complete legacy
     message regardless of size. */
  try {
    const [, end] = decoder.read(bytes, 0);
    return end === bytes.length;
  } catch {
    return false;
  }
};

/**
 * Decodes a compiled wire message; rejects trailing bytes and the 1232-byte transaction limit. The
 * fee payer is `staticAccounts[0]` — every valid transaction signs it.
 */
export const parseCompiledMessage = (bytes: Uint8Array): ParsedSolanaMessage => {
  if (bytes.length > SOLANA_TRANSACTION_MAX_BYTES) {
    throw new ChainError("invalid-request", "compiled message exceeds the 1232-byte limit");
  }
  const [first] = bytes;
  if (first === undefined) {
    throw new ChainError("invalid-request", "compiled message is empty");
  }
  // solana-message 6.0.0 src/versions/mod.rs: a high-bit first byte is a versioned message; only
  // v0 (0x80) is supported — v1 (0x81) and anything newer get a named refusal, never a blind parse.
  if (first > 0x80) {
    throw new ChainError(
      "unsupported",
      `Solana transaction version ${first - 0x80} is not supported`,
    );
  }
  let decoded: unknown;
  let end: number;
  try {
    [decoded, end] = decoder.read(bytes, 0);
  } catch {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  if (end !== bytes.length) {
    throw new ChainError("invalid-request", "compiled message has trailing bytes");
  }
  const message = asCompiledMessage(decoded);
  const staticAccounts = [...message.staticAccounts];
  const lookups = message.addressTableLookups;
  return {
    version: message.version,
    numRequiredSignatures: message.numSignerAccounts,
    staticAccounts,
    instructions: message.instructions,
    lookups: lookups.map((l) => ({
      address: l.lookupTableAddress,
      writableIndexes: l.writableIndexes,
      readonlyIndexes: l.readonlyIndexes,
    })),
  };
};

type CompiledMessage = {
  readonly version: "legacy" | 0;
  readonly numSignerAccounts: number;
  readonly staticAccounts: ReadonlyArray<string>;
  readonly instructions: ReadonlyArray<CompiledIx>;
  readonly addressTableLookups: ReadonlyArray<{
    readonly lookupTableAddress: string;
    readonly readonlyIndexes: ReadonlyArray<number>;
    readonly writableIndexes: ReadonlyArray<number>;
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
  readonlyIndexes: ReadonlyArray<number> | Uint8Array;
  writableIndexes: ReadonlyArray<number> | Uint8Array;
} =>
  isRecord(value) &&
  typeof value["lookupTableAddress"] === "string" &&
  (isNumberArray(value["readonlyIndexes"]) || value["readonlyIndexes"] instanceof Uint8Array) &&
  (isNumberArray(value["writableIndexes"]) || value["writableIndexes"] instanceof Uint8Array);

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
  const versionField = value["version"];
  if (versionField !== "legacy" && versionField !== 0) {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  const version = versionField;
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
    return {
      lookupTableAddress: t.lookupTableAddress,
      readonlyIndexes: [...t.readonlyIndexes],
      writableIndexes: [...t.writableIndexes],
    };
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
  /* v0 orders loaded addresses as every table's writable entries (table order), then every
     table's readonly entries (table order); each reference is itself an index into that table's
     declared addresses. */
  const declared = new Map(lookups.map((t) => [t.address, t.addresses]));
  const loaded = [
    ...parsed.lookups.flatMap((t) => t.writableIndexes.map((i) => declared.get(t.address)?.[i])),
    ...parsed.lookups.flatMap((t) => t.readonlyIndexes.map((i) => declared.get(t.address)?.[i])),
  ];
  return loaded[index - parsed.staticAccounts.length];
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
