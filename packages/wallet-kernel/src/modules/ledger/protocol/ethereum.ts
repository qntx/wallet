/**
 * Ethereum app client (CLA `0xE0`). Sources: refs/ledger-app-ethereum src/apdu_constants.h (INS and
 * P1/P2 values), src/features/sign_message_eip712/eip712_v1_commands.c (struct def/impl P2 values),
 * and refs/ledgerjs-npm/hw-app-eth Apache-2.0 (utils.ts safeChunkTransaction and the EIP-712
 * def/impl ordering in modules/EIP712/{index,utils}.ts).
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { TypedDataInput } from "@qntx/wallet-chains/evm";

import type { Command, Exchange } from "./apdu.ts";
import { transmit, transmitChunks } from "./apdu.ts";
import { encodePath, input, Reader, u32 } from "./bytes.ts";
import { LedgerError } from "./errors.ts";

const CLA = 0xe0;
const INS_GET_PUBLIC_KEY = 0x02;
const INS_SIGN = 0x04;
const INS_GET_APP_CONFIGURATION = 0x06;
const INS_SIGN_PERSONAL_MESSAGE = 0x08;
const INS_SIGN_EIP_712_MESSAGE = 0x0c;
const INS_EIP712_STRUCT_DEF = 0x1a;
const INS_EIP712_STRUCT_IMPL = 0x1c;

const P1_CONFIRM = 0x01;
const P1_NON_CONFIRM = 0x00;
const P1_FIRST = 0x00;
const P1_MORE = 0x80;
const P2_EIP712_V1_IMPLEM = 0x01;

const P2_DEF_NAME = 0x00;
const P2_DEF_FIELD = 0xff;
const P2_IMPL_NAME = 0x00;
const P2_IMPL_ARRAY = 0x0f;
const P2_IMPL_FIELD = 0xff;
const P1_DEF_COMPLETE = 0x00;
const P1_IMPL_PARTIAL = 0x01;
const P1_IMPL_COMPLETE = 0x00;

const MAX_PATH_DEPTH = 10;
const CHUNK = 0xff;

const utf8 = (value: string): Uint8Array => utf8ToBytes(value);

/** The JSON value form kernel typed-data parsing produces for struct fields. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const command = (ins: number, p1: number, p2: number, data: Uint8Array): Command => ({
  cla: CLA,
  ins,
  p1,
  p2,
  data,
});

/** Validates a 65-byte uncompressed key and returns its 33-byte compressed form. */
const secp256k1Compressed = (bytes: Uint8Array): Uint8Array => {
  try {
    return secp256k1.Point.fromBytes(bytes).toBytes(true);
  } catch {
    throw new LedgerError("invalid-response", "the returned key is not a secp256k1 point");
  }
};

/** `r ‖ s` from a 65-byte `v ‖ r ‖ s` reply; parity is recovered when the document is assembled. */
const rsSignature = (data: Uint8Array): Uint8Array => {
  if (data.length !== 65) {
    throw new LedgerError("invalid-response", "signature reply is not 65 bytes");
  }
  return data.subarray(1, 65);
};

/**
 * `INS_02` → `LV(65 uncompressed) ‖ LV(40 ascii hex)`. The ascii address must be the address of the
 * returned key — the check pins the response so a swapped address string cannot pass.
 */
export async function ethAddress(
  exchange: Exchange,
  keyPath: KeyPath,
  display: boolean,
): Promise<{ readonly publicKey: Uint8Array; readonly address: string }> {
  const data = await transmit(
    exchange,
    "ethereum",
    command(
      INS_GET_PUBLIC_KEY,
      display ? P1_CONFIRM : P1_NON_CONFIRM,
      0x00,
      encodePath(keyPath, MAX_PATH_DEPTH),
    ),
  );
  const reader = new Reader(data);
  const uncompressed = reader.lv();
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new LedgerError("invalid-response", "ethereum public key is not a 65-byte point");
  }
  const publicKey = secp256k1Compressed(uncompressed);
  const ascii = reader.lv();
  if (ascii.length !== 40) {
    throw new LedgerError("invalid-response", "ethereum address is not 40 hex characters");
  }
  let hexAddress: string;
  try {
    hexAddress = new TextDecoder("ascii", { fatal: true }).decode(ascii);
  } catch {
    throw new LedgerError("invalid-response", "ethereum address is not ASCII");
  }
  reader.end();
  const address = evmAddressFromPublicKey(uncompressed);
  if (hexAddress.toLowerCase() !== address.slice(2).toLowerCase()) {
    throw new LedgerError("invalid-response", "the address does not match the public key");
  }
  return { publicKey, address };
}

/** Encoded size of the RLP item starting at `offset`; overruns and bad lengths → invalid-input. */
const rlpItemLength = (rlp: Uint8Array, offset: number): number => {
  const first = rlp[offset];
  if (first === undefined) {
    throw input("truncated RLP");
  }
  if (first <= 0x7f) {
    return 1;
  }
  let header: number;
  let payload: number;
  if (first <= 0xb7) {
    header = 1;
    payload = first - 0x80;
  } else {
    const count = first <= 0xbf ? first - 0xb7 : first - 0xf7;
    const lenStart = offset + 1;
    let declared = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = rlp[lenStart + i];
      if (byte === undefined) {
        throw input("truncated RLP length");
      }
      declared = declared * 256 + byte;
    }
    header = 1 + count;
    payload = declared;
  }
  if (offset + header + payload > rlp.length) {
    throw input("RLP item overruns the buffer");
  }
  return header + payload;
};

/**
 * Encoded length of the last three top-level items of a legacy RLP list (the v, r, s tail — see
 * safeChunkTransaction's `encodedVrs`). Throws invalid-input on malformed RLP.
 */
const rlpVrsTailLength = (tx: Uint8Array): number => {
  const { 0: first } = tx;
  if (first === undefined || first < 0xc0) {
    throw input("legacy transaction is not an RLP list");
  }
  let offset = 1;
  if (first > 0xf7) {
    const count = first - 0xf7;
    let declared = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = tx[offset + i];
      if (byte === undefined) {
        throw input("truncated RLP list header");
      }
      declared = declared * 256 + byte;
    }
    offset += count;
    if (offset + declared !== tx.length) {
      throw input("RLP list length does not cover the transaction");
    }
  }
  let antepenultimate = 0;
  let penultimate = 0;
  let last = 0;
  let count = 0;
  while (offset < tx.length) {
    antepenultimate = penultimate;
    penultimate = last;
    last = offset;
    offset += rlpItemLength(tx, offset);
    count += 1;
  }
  if (offset !== tx.length || count < 3) {
    throw input("transaction is not a well-formed RLP list");
  }
  return tx.length - antepenultimate;
};

/**
 * Splits `path ‖ tx` into ≤255 chunks. A legacy transaction must never end a chunk such that only
 * its v,r,s tail remains in the last chunk (hw-app-eth safeChunkTransaction); typed transactions
 * (type byte < 0x80) use a naive split.
 */
const safeChunk = (path: Uint8Array, tx: Uint8Array): Uint8Array[] => {
  const payload = new Uint8Array(path.length + tx.length);
  payload.set(path);
  payload.set(tx, path.length);
  if (payload.length <= CHUNK) {
    return [payload];
  }
  let chunkSize = CHUNK;
  const { 0: first } = tx;
  if (first !== undefined && first >= 0xc0) {
    const tail = rlpVrsTailLength(tx);
    const remainder = payload.length % CHUNK;
    if (remainder !== 0 && remainder <= tail) {
      // any candidate > tail keeps the v,r,s tail off the final chunk; candidate 1 always
      // terminates the search since every length divides by it
      for (let candidate = CHUNK - 1; candidate >= 1; candidate -= 1) {
        const last = payload.length % candidate;
        if (last === 0 || last > tail) {
          chunkSize = candidate;
          break;
        }
      }
    }
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(payload.subarray(offset, offset + chunkSize));
  }
  return chunks;
};

/** Splits `payload` into ≤255 chunks: first `P1 0x00`, continuations `P1 0x80` (apdu_constants.h). */
const chunked = (ins: number, payload: Uint8Array): Command[] => {
  const commands: Command[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    commands.push(
      command(
        ins,
        offset === 0 ? P1_FIRST : P1_MORE,
        0x00,
        payload.subarray(offset, offset + CHUNK),
      ),
    );
  }
  return commands;
};

/**
 * `INS_04` — `unsigned` is the serialized unsigned transaction (typed: `type ‖ rlp`; legacy: the
 * RLP list including the EIP-155 `chainId,0,0` tail).
 */
export async function ethSignTransaction(
  exchange: Exchange,
  keyPath: KeyPath,
  unsigned: Uint8Array,
): Promise<Uint8Array> {
  if (unsigned.length === 0) {
    throw input("transaction is empty");
  }
  const { 0: first } = unsigned;
  // 0x01..0x7f is a typed-transaction prefix, ≥ 0xc0 a legacy RLP list; anything else is malformed.
  if (first === undefined || first < 0x01 || (first >= 0x80 && first < 0xc0)) {
    throw input("transaction is neither typed nor a legacy RLP list");
  }
  const chunks = safeChunk(encodePath(keyPath, MAX_PATH_DEPTH), unsigned);
  const commands = chunks.map((data, i) =>
    command(INS_SIGN, i === 0 ? P1_FIRST : P1_MORE, 0x00, data),
  );
  return rsSignature(await transmitChunks(exchange, "ethereum", commands));
}

/** `INS_08` — `path ‖ u32 length ‖ message`, streamed in ≤255-byte chunks. */
export async function ethSignPersonalMessage(
  exchange: Exchange,
  keyPath: KeyPath,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (message.length > 0xff_ff_ff_ff) {
    throw input("message exceeds the u32 length field");
  }
  const path = encodePath(keyPath, MAX_PATH_DEPTH);
  const payload = new Uint8Array(path.length + 4 + message.length);
  payload.set(path);
  payload.set(u32(message.length), path.length);
  payload.set(message, path.length + 4);
  return rsSignature(
    await transmitChunks(exchange, "ethereum", chunked(INS_SIGN_PERSONAL_MESSAGE, payload)),
  );
}

/** Atomic EIP-712 type keys — eip712_v1_commands.c + utils.ts EIP712_TYPE_PROPERTIES. */
const TYPE_KEYS = {
  custom: 0,
  int: 1,
  uint: 2,
  address: 3,
  bool: 4,
  string: 5,
  bytesFixed: 6,
  bytesDynamic: 7,
} as const;

type DestructedType = {
  readonly name: string;
  readonly size: number | undefined;
  readonly arrays: ReadonlyArray<number | undefined>;
};

/** Port of destructTypeFromString: `baseType` + array suffixes in declaration order. */
const destructType = (typeName: string): DestructedType => {
  const match = /^([^[\]]*)((?:\[\d*\])*)$/.exec(typeName);
  const base = match?.[1];
  const suffix = match?.[2];
  if (match === null || base === undefined || base === "" || suffix === undefined) {
    throw input("malformed EIP-712 type");
  }
  const sized = /^(u?int|bytes)(\d{0,3})$/.exec(base);
  const name = sized?.[1] ?? base;
  const sizeText = sized?.[2];
  const size = sizeText === undefined || sizeText === "" ? undefined : Number(sizeText);
  if (
    (name === "int" || name === "uint") &&
    size !== undefined &&
    (size % 8 !== 0 || size < 8 || size > 256)
  ) {
    throw input("invalid EIP-712 integer width");
  }
  if (name === "bytes" && size !== undefined && (size < 1 || size > 32)) {
    throw input("invalid EIP-712 bytes width");
  }
  const arrays: Array<number | undefined> = [];
  for (const dim of suffix.matchAll(/\[(\d*)\]/g)) {
    arrays.push(dim[1] === undefined || dim[1] === "" ? undefined : Number(dim[1]));
  }
  return { name, size, arrays };
};

const ATOMIC: ReadonlySet<string> = new Set(["int", "uint", "address", "bool", "string", "bytes"]);

const atomicKind = (t: DestructedType): number | undefined => {
  switch (t.name) {
    case "int":
      return TYPE_KEYS.int;
    case "uint":
      return TYPE_KEYS.uint;
    case "address":
      return TYPE_KEYS.address;
    case "bool":
      return TYPE_KEYS.bool;
    case "string":
      return TYPE_KEYS.string;
    case "bytes":
      return t.size === undefined ? TYPE_KEYS.bytesDynamic : TYPE_KEYS.bytesFixed;
    default:
      return undefined;
  }
};

/**
 * The field-definition payload (utils.ts makeTypeEntryStructBuffer): typedesc byte (bit7 array,
 * bit6 has-size, low nibble type key), optional custom-type name, optional type size, optional
 * array levels, then `u8 ‖ name`.
 */
const structFieldDefinition = (fieldName: string, typeName: string): Uint8Array => {
  const t = destructType(typeName);
  const key = atomicKind(t);
  const isArray = t.arrays.length > 0;
  const isCustom = key === undefined;
  // intN/uintN sizes are bits→bytes; bytesN's declared size is bytes already
  const typeSize =
    key === TYPE_KEYS.int || key === TYPE_KEYS.uint
      ? Math.floor((t.size ?? 256) / 8)
      : key === TYPE_KEYS.bytesFixed
        ? t.size
        : undefined;
  // oxlint-disable eslint/no-bitwise -- the EIP-712 type key packs flag bits (eip712_v1_parse.c TYPE_*)
  const parts: number[] = [
    (isArray ? 0x80 : 0) |
      (typeSize === undefined ? 0 : 0x40) |
      (isCustom ? TYPE_KEYS.custom : key),
  ];
  // oxlint-enable eslint/no-bitwise
  if (isCustom) {
    const name = utf8(t.name);
    if (name.length > 0xff) {
      throw input("EIP-712 type name exceeds 255 bytes");
    }
    parts.push(name.length, ...name);
  }
  if (typeSize !== undefined) {
    parts.push(typeSize);
  }
  if (isArray) {
    if (t.arrays.length > 0xff) {
      throw input("array level count exceeds 255");
    }
    parts.push(t.arrays.length);
    for (const size of t.arrays) {
      if (size === undefined) {
        parts.push(0x00); // ARRAY_DYNAMIC
      } else {
        if (size > 0xff) {
          throw input("fixed array size exceeds 255");
        }
        parts.push(0x01, size); // ARRAY_FIXED_SIZE
      }
    }
  }
  const field = utf8(fieldName);
  if (field.length > 0xff) {
    throw input("EIP-712 field name exceeds 255 bytes");
  }
  parts.push(field.length, ...field);
  return Uint8Array.from(parts);
};

const bigEndianMinimal = (value: bigint): Uint8Array => {
  if (value < 0n) {
    throw input("negative value cannot be encoded unsigned");
  }
  if (value === 0n) {
    return Uint8Array.of(0);
  }
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  return hexToBytes(hex);
};

/** Mirrors the value forms ox's ABI integer encoding accepts — anything `BigInt()` parses. */
const toBigInt = (value: unknown): bigint | undefined => {
  switch (typeof value) {
    case "bigint":
    case "boolean":
    case "number":
    case "string":
      try {
        return BigInt(value);
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
};

const hexBytes = (value: unknown): Uint8Array | undefined => {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    return undefined;
  }
  return hexToBytes(value.slice(2));
};

/**
 * The wire encoding of one atomic field value (utils.ts EIP712_TYPE_ENCODERS). Accepted value forms
 * mirror the encoder the kernel hashes with (ox TypedData → AbiParameters.encode): int/uint take
 * anything `BigInt()` parses, bool only `boolean`, address/bytes only `0x` hex (bytesN exact
 * length), string is stringified. A missing field is `invalid-input` — a zero fail-safe could never
 * match the hash of a document the field is absent from.
 */
const encodeFieldValue = (t: DestructedType, value: unknown): Uint8Array => {
  if (value === undefined) {
    throw input("EIP-712 field has no value");
  }
  const bits = t.size ?? 256;
  switch (t.name) {
    case "uint": {
      const v = toBigInt(value);
      if (v === undefined || v < 0n || v >= 2n ** BigInt(bits)) {
        throw input("uint value out of range");
      }
      return bigEndianMinimal(v);
    }
    case "int": {
      const v = toBigInt(value);
      const min = -(2n ** BigInt(bits - 1));
      const max = 2n ** BigInt(bits - 1) - 1n;
      if (v === undefined || v < min || v > max) {
        throw input("int value out of range");
      }
      // negative → two's complement at the declared width (utils.ts INT encoder)
      return bigEndianMinimal(v < 0n ? v + 2n ** BigInt(bits) : v);
    }
    case "address": {
      const bytes = hexBytes(value);
      if (bytes === undefined || bytes.length !== 20) {
        throw input("address value is not a 0x-prefixed 20-byte hex string");
      }
      return bytes;
    }
    case "bool":
      if (typeof value !== "boolean") {
        throw input("bool value is not a boolean");
      }
      return Uint8Array.of(value ? 1 : 0);

    case "string":
      // oxlint-disable-next-line typescript/no-base-to-string -- mirrors ox's `${value}` normalizeString
      return utf8(String(value));

    case "bytes": {
      const bytes = hexBytes(value);
      if (bytes === undefined) {
        throw input("bytes value is not 0x-prefixed hex");
      }
      if (t.size !== undefined && bytes.length !== t.size) {
        throw input("fixed bytes value is not the declared size");
      }
      return bytes;
    }
    default:
      throw input("not an atomic EIP-712 type");
  }
};

/**
 * `INS_1C` field value: `u16 ‖ encoded` split across APDUs of ≤255 bytes; non-last chunks carry
 * `P1_PARTIAL`, the last `P1_COMPLETE` (eip712_v1_commands.c accepts any non-zero P1 as partial).
 */
const implFieldCommands = (encoded: Uint8Array): Command[] => {
  const payload = new Uint8Array(2 + encoded.length);
  new DataView(payload.buffer).setUint16(0, encoded.length);
  payload.set(encoded, 2);
  const commands: Command[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const last = offset + CHUNK >= payload.length;
    commands.push(
      command(
        INS_EIP712_STRUCT_IMPL,
        last ? P1_IMPL_COMPLETE : P1_IMPL_PARTIAL,
        P2_IMPL_FIELD,
        payload.subarray(offset, offset + CHUNK),
      ),
    );
  }
  return commands;
};

/** `Object.entries` comparator matching `Object.keys(types).sort()` ordering. */
const byTypeName = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * `INS_0C` full mode (`P2 0x01`) — sends all struct definitions (types sorted alphabetically, as
 * hw-app-eth does to keep the schema hash stable), then the EIP712Domain and primaryType
 * implementations, then the signing path. Sends no filters: on the pinned app that leaves the BASIC
 * filtering mode, which requires the blind-signing setting to sign.
 */
export async function ethSignTypedData(
  exchange: Exchange,
  keyPath: KeyPath,
  typedData: TypedDataInput,
): Promise<Uint8Array> {
  const { types, primaryType, domain, message } = typedData;
  if (types[primaryType] === undefined) {
    throw input("primary type is not declared in types");
  }
  const path = encodePath(keyPath, MAX_PATH_DEPTH);
  const commands: Command[] = [];

  for (const [typeName, fields] of Object.entries(types).sort(byTypeName)) {
    commands.push(command(INS_EIP712_STRUCT_DEF, P1_DEF_COMPLETE, P2_DEF_NAME, utf8(typeName)));
    for (const field of fields) {
      commands.push(
        command(
          INS_EIP712_STRUCT_DEF,
          P1_DEF_COMPLETE,
          P2_DEF_FIELD,
          structFieldDefinition(field.name, field.type),
        ),
      );
    }
  }

  const implFields = (structName: string, value: Record<string, unknown>, depth: number): void => {
    if (depth > 32) {
      throw input("EIP-712 nesting exceeds the depth bound");
    }
    const fields = types[structName];
    if (fields === undefined) {
      throw input(`undeclared EIP-712 struct ${JSON.stringify(structName)}`);
    }
    for (const field of fields) {
      implValue(destructType(field.type), value[field.name], depth);
    }
  };

  const implValue = (t: DestructedType, value: unknown, depth: number): void => {
    if (t.arrays.length > 0) {
      const [level, ...rest] = t.arrays;
      if (!Array.isArray(value)) {
        throw input("EIP-712 array field is not an array");
      }
      if (level !== undefined && value.length !== level) {
        throw input("fixed array length does not match its declared size");
      }
      if (value.length > 0xff) {
        throw input("EIP-712 array has more than 255 entries");
      }
      commands.push(
        command(
          INS_EIP712_STRUCT_IMPL,
          P1_IMPL_COMPLETE,
          P2_IMPL_ARRAY,
          Uint8Array.of(value.length),
        ),
      );
      for (const entry of value) {
        implValue({ name: t.name, size: t.size, arrays: rest }, entry, depth + 1);
      }
      return;
    }
    if (!ATOMIC.has(t.name)) {
      if (!isRecord(value)) {
        throw input("EIP-712 struct field is not an object");
      }
      // Nested structs auto-descend on the device — no extra APDU (eip712_v1_parse.c).
      implFields(t.name, value, depth + 1);
      return;
    }
    commands.push(...implFieldCommands(encodeFieldValue(t, value)));
  };

  commands.push(
    command(INS_EIP712_STRUCT_IMPL, P1_IMPL_COMPLETE, P2_IMPL_NAME, utf8("EIP712Domain")),
  );
  const domainFields = types["EIP712Domain"];
  if (domainFields === undefined) {
    throw input("types has no EIP712Domain");
  }
  for (const field of domainFields) {
    implValue(destructType(field.type), domain[field.name], 0);
  }

  commands.push(command(INS_EIP712_STRUCT_IMPL, P1_IMPL_COMPLETE, P2_IMPL_NAME, utf8(primaryType)));
  implFields(primaryType, message, 0);

  commands.push(command(INS_SIGN_EIP_712_MESSAGE, P1_NON_CONFIRM, P2_EIP712_V1_IMPLEM, path));

  return rsSignature(await transmitChunks(exchange, "ethereum", commands));
}

/**
 * `INS_06` — `flags ‖ major ‖ minor ‖ patch`; flags bit 0 is APP_FLAG_DATA_ALLOWED, the "Blind
 * signing" setting (src/apdu_constants.h).
 */
export async function ethConfiguration(
  exchange: Exchange,
): Promise<{ readonly version: string; readonly blindSigning: boolean }> {
  const data = await transmit(
    exchange,
    "ethereum",
    command(INS_GET_APP_CONFIGURATION, 0x00, 0x00, new Uint8Array(0)),
  );
  const reader = new Reader(data);
  const flags = reader.u8();
  const major = reader.u8();
  const minor = reader.u8();
  const patch = reader.u8();
  reader.end();
  // oxlint-disable-next-line eslint/no-bitwise -- the configuration reply is a bitmask (app-ethereum doc)
  return { version: `${major}.${minor}.${patch}`, blindSigning: (flags & 0x01) !== 0 };
}
