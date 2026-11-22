// oxlint-disable eslint/no-bitwise -- the SIMD-0385 config mask is a bit field
import { getCompiledTransactionMessageDecoder } from "@solana/transaction-messages";

import { ChainError } from "../index.ts";
import { isSolanaAddress } from "./ids.ts";

// Agave runtime-transaction/src/transaction_limits.rs: PACKET_DATA_SIZE bounds legacy/v0 wires.
export const LEGACY_TRANSACTION_MAX_BYTES = 1232;
// solana-message 6.0.0 src/versions/v1/mod.rs: a v1 transaction (message + signatures) is 4096.
export const V1_TRANSACTION_MAX_BYTES = 4096;

export type CompiledIx = {
  readonly programAddressIndex: number;
  readonly accountIndices: ReadonlyArray<number>;
  readonly data: Uint8Array;
};

/** The resource limits and priority fee a v1 message's config mask declares (SIMD-0385). */
export type SolanaTransactionConfig = {
  /** Bits 0+1: the total priority fee in lamports (not a per-unit price). */
  readonly priorityFeeLamports?: bigint;
  /** Bit 2: compute-unit limit. */
  readonly computeUnitLimit?: number;
  /** Bit 3: loaded-accounts-data-size limit. */
  readonly loadedAccountsDataSizeLimit?: number;
  /** Bit 4: heap size in bytes. */
  readonly heapSize?: number;
};

type ParsedSolanaMessageBase = {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignerAccounts: number;
  readonly numReadonlyNonSignerAccounts: number;
  readonly staticAccounts: ReadonlyArray<string>;
  /** The lifetime specifier (recent blockhash) as base58 — every version carries it. */
  readonly lifetimeToken: string;
  readonly instructions: ReadonlyArray<CompiledIx>;
  readonly lookups: ReadonlyArray<LookupReference>;
};

export type ParsedSolanaMessage = ParsedSolanaMessageBase &
  (
    | { readonly version: "legacy" | 0 }
    | { readonly version: 1; readonly config: SolanaTransactionConfig }
  );

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
 * Decodes a compiled wire message; rejects trailing bytes and the transaction size limit (1232 for
 * legacy/v0, 4096 including signatures for v1). The fee payer is `staticAccounts[0]` — every valid
 * transaction signs it.
 */
export const parseCompiledMessage = (bytes: Uint8Array): ParsedSolanaMessage => {
  const [first] = bytes;
  if (first === undefined) {
    throw new ChainError("invalid-request", "compiled message is empty");
  }
  // solana-message 6.0.0 src/versions/mod.rs: a high-bit first byte is a versioned message; v0
  // (0x80) and v1 (0x81) are supported — anything newer gets a named refusal, never a blind parse.
  if (first === 0x81) {
    return parseV1Message(bytes);
  }
  if (first > 0x81) {
    throw new ChainError(
      "unsupported",
      `Solana transaction version ${first - 0x80} is not supported`,
    );
  }
  if (bytes.length > LEGACY_TRANSACTION_MAX_BYTES) {
    throw new ChainError("invalid-request", "compiled message exceeds the 1232-byte limit");
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
    numReadonlySignerAccounts: message.numReadonlySignerAccounts,
    numReadonlyNonSignerAccounts: message.numReadonlyNonSignerAccounts,
    staticAccounts,
    lifetimeToken: message.lifetimeToken,
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
  readonly numReadonlySignerAccounts: number;
  readonly numReadonlyNonSignerAccounts: number;
  readonly staticAccounts: ReadonlyArray<string>;
  readonly lifetimeToken: string;
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
  const { lifetimeToken } = value;
  if (
    typeof header["numSignerAccounts"] !== "number" ||
    typeof header["numReadonlySignerAccounts"] !== "number" ||
    typeof header["numReadonlyNonSignerAccounts"] !== "number" ||
    !isStringArray(staticAccounts) ||
    typeof lifetimeToken !== "string" ||
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
    numReadonlySignerAccounts: header["numReadonlySignerAccounts"],
    numReadonlyNonSignerAccounts: header["numReadonlyNonSignerAccounts"],
    staticAccounts,
    lifetimeToken,
    instructions: ixs,
    addressTableLookups: tables,
  };
};

/* v1 (SIMD-0385) fixed fields: 0x81 ‖ header(3) ‖ configMask(u32 LE) ‖ lifetime(32) ‖ two counts. */
const V1_MESSAGE_MIN_BYTES = 42;
// Agave transaction_config_view.rs: ALLOWED_TRANSACTION_CONFIG_MASK.
const V1_CONFIG_MASK_KNOWN = 0b1_1111;
// Bits 0+1 carry the priority fee as one u64 and are valid only as a pair.
const V1_PRIORITY_FEE_BITS = 0b11;
const V1_MAX_SIGNATURES = 12;
const V1_MAX_ACCOUNTS = 64;
const V1_MAX_INSTRUCTIONS = 64;
const V1_HEAP_MIN = 32 * 1024;
const V1_HEAP_MAX = 256 * 1024;
const V1_HEAP_MULTIPLE = 1024;

type V1InstructionHeader = {
  readonly programAccountIndex: number;
  readonly numInstructionAccounts: number;
  readonly numInstructionDataBytes: number;
};

type V1InstructionPayload = {
  readonly instructionAccountIndices: ReadonlyArray<number> | Uint8Array;
  readonly instructionData: Uint8Array;
};

type CompiledV1Message = {
  readonly version: 1;
  readonly header: {
    readonly numSignerAccounts: number;
    readonly numReadonlySignerAccounts: number;
    readonly numReadonlyNonSignerAccounts: number;
  };
  readonly instructions: ReadonlyArray<{
    readonly programAccountIndex: number;
    readonly accountIndices: ReadonlyArray<number> | Uint8Array;
    readonly data: Uint8Array;
  }>;
  readonly lifetimeToken: string;
  readonly staticAccounts: ReadonlyArray<string>;
};

const isV1InstructionHeader = (value: unknown): value is V1InstructionHeader =>
  isRecord(value) &&
  typeof value["programAccountIndex"] === "number" &&
  typeof value["numInstructionAccounts"] === "number" &&
  typeof value["numInstructionDataBytes"] === "number";

const isV1InstructionPayload = (value: unknown): value is V1InstructionPayload =>
  isRecord(value) &&
  (isNumberArray(value["instructionAccountIndices"]) ||
    value["instructionAccountIndices"] instanceof Uint8Array) &&
  value["instructionData"] instanceof Uint8Array;

const asV1Message = (value: unknown): CompiledV1Message => {
  if (!isRecord(value) || !isRecord(value["header"])) {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  const { header } = value;
  const { staticAccounts } = value;
  const headers = value["instructionHeaders"];
  const payloads = value["instructionPayloads"];
  if (
    value["version"] !== 1 ||
    typeof header["numSignerAccounts"] !== "number" ||
    typeof header["numReadonlySignerAccounts"] !== "number" ||
    typeof header["numReadonlyNonSignerAccounts"] !== "number" ||
    typeof value["lifetimeToken"] !== "string" ||
    !isStringArray(staticAccounts) ||
    !Array.isArray(headers) ||
    !Array.isArray(payloads)
  ) {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  /* Zip the header with its payload in one pass: a missing or malformed payload fails the
     same payload check, so no separate count comparison is needed (kit derives both arrays
     from the same numInstructions count). */
  const instructions = headers.map((h, i) => {
    const payload: unknown = payloads[i];
    if (!isV1InstructionHeader(h) || !isV1InstructionPayload(payload)) {
      throw new ChainError("invalid-request", "compiled message failed to decode");
    }
    return {
      programAccountIndex: h.programAccountIndex,
      accountIndices: payload.instructionAccountIndices,
      data: payload.instructionData,
    };
  });
  return {
    version: 1,
    header: {
      numSignerAccounts: header["numSignerAccounts"],
      numReadonlySignerAccounts: header["numReadonlySignerAccounts"],
      numReadonlyNonSignerAccounts: header["numReadonlyNonSignerAccounts"],
    },
    instructions,
    lifetimeToken: value["lifetimeToken"],
    staticAccounts,
  };
};

/* The config a valid mask declares: values sit after the static accounts (0x81 ‖ header ‖ mask ‖
   lifetime ‖ counts ‖ accounts) in bit order — u64 LE priority fee if bits 0+1, then u32 LE per
   remaining bit. The mask passed its checks and kit decoded the whole frame, so every byte the
   mask declares is present — read it straight from the wire rather than trusting kit's
   configValues array. */
const v1Config = (
  mask: number,
  bytes: Uint8Array,
  staticAccountCount: number,
): SolanaTransactionConfig => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + 42 + 32 * staticAccountCount);
  let offset = 0;
  const config: {
    priorityFeeLamports?: bigint;
    computeUnitLimit?: number;
    loadedAccountsDataSizeLimit?: number;
    heapSize?: number;
  } = {};
  if ((mask & V1_PRIORITY_FEE_BITS) !== 0) {
    config.priorityFeeLamports = view.getBigUint64(offset, true);
    offset += 8;
  }
  if ((mask & 0b100) !== 0) {
    config.computeUnitLimit = view.getUint32(offset, true);
    offset += 4;
  }
  if ((mask & 0b1000) !== 0) {
    config.loadedAccountsDataSizeLimit = view.getUint32(offset, true);
    offset += 4;
  }
  if ((mask & 0b10000) !== 0) {
    config.heapSize = view.getUint32(offset, true);
  }
  return config;
};

/* Agave sanitize.rs + transaction_limits.rs applied to a decoded v1 message (Keystone's
   message_v1.rs runs the same set): a cluster rejects every violation below, so the wallet
   refuses before a signature could cover it. */
const sanitizeV1Message = (message: CompiledV1Message, config: SolanaTransactionConfig): void => {
  const {
    numSignerAccounts: signatures,
    numReadonlySignerAccounts: readonlySigners,
    numReadonlyNonSignerAccounts: readonlyNonSigners,
  } = message.header;
  const accounts = message.staticAccounts.length;
  if (signatures < 1 || signatures > V1_MAX_SIGNATURES) {
    throw new ChainError(
      "invalid-request",
      `v1 message requires ${signatures} signatures (1–12 allowed)`,
    );
  }
  if (readonlySigners >= signatures) {
    throw new ChainError(
      "invalid-request",
      `v1 message marks ${readonlySigners} of ${signatures} signers read-only`,
    );
  }
  // accounts-db account_locks.rs: DEFAULT_TX_ACCOUNT_LOCKS = 64 — SIMD-0596's 96-account limit
  // is not active on any cluster, so 64 is the bound.
  if (accounts > V1_MAX_ACCOUNTS) {
    throw new ChainError(
      "invalid-request",
      `v1 message declares ${accounts} accounts (64 allowed)`,
    );
  }
  if (accounts < signatures + readonlyNonSigners) {
    throw new ChainError(
      "invalid-request",
      `v1 message has ${accounts} accounts for ${signatures} signers and ${readonlyNonSigners} read-only non-signers`,
    );
  }
  if (message.instructions.length > V1_MAX_INSTRUCTIONS) {
    throw new ChainError(
      "invalid-request",
      `v1 message declares ${message.instructions.length} instructions (64 allowed)`,
    );
  }
  const seen = new Set<string>();
  for (const account of message.staticAccounts) {
    if (seen.has(account)) {
      throw new ChainError("invalid-request", `v1 message repeats account ${account}`);
    }
    seen.add(account);
  }
  for (const [i, instruction] of message.instructions.entries()) {
    if (instruction.programAccountIndex === 0) {
      throw new ChainError(
        "invalid-request",
        `v1 instruction ${i} uses the fee payer as its program`,
      );
    }
    if (instruction.programAccountIndex >= accounts) {
      throw new ChainError(
        "invalid-request",
        `v1 instruction ${i} uses program index ${instruction.programAccountIndex} of ${accounts} accounts`,
      );
    }
    for (const index of instruction.accountIndices) {
      if (index >= accounts) {
        throw new ChainError(
          "invalid-request",
          `v1 instruction ${i} uses account index ${index} of ${accounts} accounts`,
        );
      }
    }
  }
  const heap = config.heapSize;
  if (
    heap !== undefined &&
    (heap % V1_HEAP_MULTIPLE !== 0 || heap < V1_HEAP_MIN || heap > V1_HEAP_MAX)
  ) {
    throw new ChainError(
      "invalid-request",
      `v1 heap size ${heap} is not a multiple of 1024 within 32768–262144`,
    );
  }
};

/**
 * A v1 message: the mask is checked before kit decodes — kit reads only the bits it knows, so an
 * unknown bit or a half priority-fee pair must be caught here. The size bound covers the whole
 * transaction (message plus 64 bytes per required signature), then every Agave sanitize rule runs
 * before the message maps onto the same model as legacy/v0.
 */
const parseV1Message = (bytes: Uint8Array): ParsedSolanaMessage => {
  if (bytes.length < V1_MESSAGE_MIN_BYTES) {
    throw new ChainError("invalid-request", "compiled message failed to decode");
  }
  const mask = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  if ((mask & ~V1_CONFIG_MASK_KNOWN) !== 0) {
    throw new ChainError(
      "unsupported",
      `Solana v1 transaction config mask 0x${mask.toString(16)} sets bits this wallet does not know`,
    );
  }
  if (
    (mask & V1_PRIORITY_FEE_BITS) !== 0 &&
    (mask & V1_PRIORITY_FEE_BITS) !== V1_PRIORITY_FEE_BITS
  ) {
    throw new ChainError(
      "invalid-request",
      "Solana v1 transaction config mask sets only one of the two priority-fee bits",
    );
  }
  if (bytes.length + 64 * (bytes[1] ?? 0) > V1_TRANSACTION_MAX_BYTES) {
    throw new ChainError("invalid-request", "v1 transaction exceeds the 4096-byte limit");
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
  const message = asV1Message(decoded);
  const config = v1Config(mask, bytes, message.staticAccounts.length);
  sanitizeV1Message(message, config);
  return {
    version: 1,
    numRequiredSignatures: message.header.numSignerAccounts,
    numReadonlySignerAccounts: message.header.numReadonlySignerAccounts,
    numReadonlyNonSignerAccounts: message.header.numReadonlyNonSignerAccounts,
    staticAccounts: [...message.staticAccounts],
    lifetimeToken: message.lifetimeToken,
    instructions: message.instructions.map((instruction) => ({
      programAddressIndex: instruction.programAccountIndex,
      accountIndices: [...instruction.accountIndices],
      data: new Uint8Array(instruction.data),
    })),
    lookups: [],
    config,
  };
};

/**
 * Whether the account `index` is writable in the message: a static signer index is writable below
 * `numRequiredSignatures - numReadonlySignerAccounts`, a static non-signer index below
 * `staticAccounts.length - numReadonlyNonSignerAccounts`, and a loaded index is writable exactly in
 * the leading writable section of the loaded addresses.
 */
export const isWritableIndex = (parsed: ParsedSolanaMessage, index: number): boolean => {
  const n = parsed.staticAccounts.length;
  if (index < n) {
    return index < parsed.numRequiredSignatures
      ? index < parsed.numRequiredSignatures - parsed.numReadonlySignerAccounts
      : index < n - parsed.numReadonlyNonSignerAccounts;
  }
  let writable = 0;
  for (const lookup of parsed.lookups) {
    writable += lookup.writableIndexes.length;
  }
  return index - n < writable;
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
