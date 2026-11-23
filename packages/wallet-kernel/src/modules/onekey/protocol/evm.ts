/**
 * EVM signing over the OneKey V1 schema: legacy and EIP-1559/7702 transactions with data chunking,
 * personal messages, and EIP-712 typed data in both firmware modes — the streaming struct/value
 * protocol (`EthereumTypedDataStructRequestOneKey`/`ValueRequestOneKey` rounds) and the blind
 * hash-only call. Message mapping mirrors the SDK's `api/evm/latest/signTransaction.ts` (minimal
 * big-endian integer fields, first ≤1024-byte chunk in the sign message, `dataLength` rounds
 * answered with `EthereumTxAckOneKey`); the typed-data answer protocol mirrors
 * `apps/ethereum/onekey/sign_typed_data.py` in firmware-pro (member paths root at 0 = domain, 1 =
 * message; array lengths answered as uint16 big-endian).
 *
 * The stream-vs-hash decision (`typedDataMode`) mirrors the SDK's EVMSignTypedData.ts run(): the
 * classic family streams only with Capability_EthereumTypedData and documents inside the mini
 * limits (hasClassicFamilyTypedDataFormatViolations), and every model falls back to hash for nested
 * arrays or an oversized `data` field (hasBiggerData).
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

import type { EvmTransaction } from "@qntx/wallet-chains";
import { parseTypedData } from "@qntx/wallet-chains/evm";

import { supports } from "./device.ts";
import type { DeviceInfo } from "./device.ts";
import { OneKeyError } from "./errors.ts";
import {
  EthereumMessageSignatureOneKey,
  EthereumSignMessageOneKey,
  EthereumSignTxEIP1559OneKey,
  EthereumSignTxEIP7702OneKey,
  EthereumSignTxOneKey,
  EthereumSignTypedDataOneKey,
  EthereumSignTypedHashOneKey,
  EthereumTxAckOneKey,
  EthereumTxRequestOneKey,
  EthereumTypedDataSignatureOneKey,
  EthereumTypedDataStructAckOneKey,
  EthereumTypedDataStructRequestOneKey,
  EthereumTypedDataValueAckOneKey,
  EthereumTypedDataValueRequestOneKey,
} from "./messages.ts";
import type { EthereumFieldTypeOneKeyFields, EthereumTxRequestOneKeyFields } from "./messages.ts";
import type { Decoded, Fields } from "./proto.ts";
import { call } from "./session.ts";
import type { Exchange } from "./session.ts";

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);
const invalid = (message: string): OneKeyError => new OneKeyError("invalid-input", message);
const unsupported = (message: string): OneKeyError => new OneKeyError("unsupported", message);

const UINT32_MAX = 0xff_ff_ff_ff;
const CHUNK = 1024;
const MAX_ROUNDS = 4096;

// Failure_DataError (common/protob/messages-common.proto FailureType = 3): the firmware refuses
// an unregistered EIP-7702 delegator with it (sign_tx_eip7702.py validate_delegate,
// ethereum_onekey.c "Unregistered delegator").
const FAILURE_DATA_ERROR = 3;

function checkPath(path: ReadonlyArray<number>): void {
  if (path.length === 0) {
    throw invalid("derivation path is empty");
  }
  for (const element of path) {
    if (!Number.isInteger(element) || element < 0 || element > UINT32_MAX) {
      throw invalid("derivation path element out of range");
    }
  }
}

/** The minimal big-endian byte string of a non-negative integer; zero encodes empty. */
function minimalBytes(value: bigint): Uint8Array {
  if (value < 0n) {
    throw invalid("negative quantity");
  }
  if (value === 0n) {
    return new Uint8Array(0);
  }
  const out: number[] = [];
  for (let v = value; v > 0n; v /= 256n) {
    out.push(Number(v % 256n));
  }
  return new Uint8Array(out.reverse());
}

const quantity = (hex: string): Uint8Array => minimalBytes(BigInt(hex));

const hexBytes = (hex: string): Uint8Array => {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

type TxRequest = Decoded<EthereumTxRequestOneKeyFields>;

/** One EIP-7702 authorization signature as the wire record carries it (yParity ‖ r ‖ s). */
export type EvmAuthorizationSignature = {
  readonly yParity: 0 | 1;
  readonly r: Uint8Array;
  readonly s: Uint8Array;
};

/**
 * Drives the TxRequest/TxAck loop after the sign message is sent: each dataLength request must ask
 * for 1..min(remaining, 1024) bytes (the schema caps chunks at 1024), and a signature may only
 * arrive when nothing is left to send. `r`/`s` are exactly 32 bytes; an `eip7702` response must
 * carry exactly one authorization signature, others must carry none.
 */
async function finishTransaction(
  exchange: Exchange,
  request: TxRequest,
  data: Uint8Array,
  sent: number,
  expectAuthorization: boolean,
): Promise<{ signature: Uint8Array; authorization?: EvmAuthorizationSignature }> {
  const want = request.dataLength;
  if (want === undefined || want === 0) {
    if (sent < data.length) {
      throw fault("device signed before consuming the payload");
    }
    const { signatureV, signatureR, signatureS } = request;
    if (signatureV === undefined || signatureR === undefined || signatureS === undefined) {
      throw fault("signature fields missing from the transaction request");
    }
    if (signatureR.length !== 32 || signatureS.length !== 32) {
      throw fault("signature r/s are not 32 bytes");
    }
    const signatures = request.authorizationSignatures ?? [];
    if (expectAuthorization) {
      if (signatures.length !== 1) {
        throw fault("expected exactly one authorization signature");
      }
      const [auth] = signatures;
      if (auth === undefined) {
        throw fault("expected exactly one authorization signature");
      }
      if (auth.yParity !== 0 && auth.yParity !== 1) {
        throw fault("authorization yParity is not 0 or 1");
      }
      if (auth.r.length !== 32 || auth.s.length !== 32) {
        throw fault("authorization r/s are not 32 bytes");
      }
      return {
        signature: concat(signatureR, signatureS),
        authorization: { yParity: auth.yParity, r: auth.r, s: auth.s },
      };
    }
    if (signatures.length > 0) {
      throw fault("unexpected authorization signatures");
    }
    return { signature: concat(signatureR, signatureS) };
  }
  const remaining = data.length - sent;
  if (want > remaining || want > CHUNK) {
    throw fault("device requested more payload than remains");
  }
  const next = await call(
    exchange,
    { def: EthereumTxAckOneKey, value: { dataChunk: data.subarray(sent, sent + want) } },
    EthereumTxRequestOneKey,
  );
  return finishTransaction(exchange, next, data, sent + want, expectAuthorization);
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export type EvmTransactionOptions = {
  /**
   * Stage-2 call of a two-stage EIP-7702 plan: the stage-1 authorization signature to embed in the
   * authorization tuple — feed the previous call's `authorization` result straight back. Both
   * firmwares skip re-signing and echo it back (sign_tx_eip7702.py sign_authorization,
   * ethereum_onekey.c sign_authorization_list).
   */
  readonly authorization?: EvmAuthorizationSignature;
};

/**
 * Signs an EVM transaction. eip2930 has no OneKey message and is `unsupported` before any exchange;
 * eip7702 needs `evm-7702` and an unregistered delegator refusal (Failure_DataError) maps to
 * `unsupported` as well.
 */
// oxlint-disable-next-line typescript/consistent-return -- every transaction kind returns above
export async function signEvmTransaction(
  exchange: Exchange,
  info: DeviceInfo,
  path: ReadonlyArray<number>,
  tx: EvmTransaction,
  options?: EvmTransactionOptions,
): Promise<{ signature: Uint8Array; authorization?: EvmAuthorizationSignature }> {
  checkPath(path);
  const data = hexBytes(tx.data);
  const initialChunk = data.subarray(0, CHUNK);
  try {
    switch (tx.type) {
      case "legacy": {
        const value = {
          addressN: [...path],
          nonce: minimalBytes(BigInt(tx.nonce)),
          gasPrice: quantity(tx.gasPrice),
          gasLimit: quantity(tx.gas),
          ...(tx.to === undefined ? {} : { to: tx.to }),
          value: quantity(tx.value),
          chainId: BigInt(tx.chainId),
          ...(data.length === 0 ? {} : { dataInitialChunk: initialChunk, dataLength: data.length }),
        };
        const first = await call(
          exchange,
          { def: EthereumSignTxOneKey, value },
          EthereumTxRequestOneKey,
        );
        return await finishTransaction(
          exchange,
          first,
          data.subarray(initialChunk.length),
          0,
          false,
        );
      }
      case "eip2930":
        throw unsupported("eip2930 transactions have no OneKey message");
      case "eip1559": {
        const value = {
          addressN: [...path],
          nonce: minimalBytes(BigInt(tx.nonce)),
          maxGasFee: quantity(tx.maxFeePerGas),
          maxPriorityFee: quantity(tx.maxPriorityFeePerGas),
          gasLimit: quantity(tx.gas),
          ...(tx.to === undefined ? {} : { to: tx.to }),
          value: quantity(tx.value),
          dataInitialChunk: initialChunk,
          dataLength: data.length,
          chainId: BigInt(tx.chainId),
          accessList: tx.accessList.map((entry) => ({
            address: entry.address,
            storageKeys: entry.storageKeys.map(hexBytes),
          })),
        };
        const first = await call(
          exchange,
          { def: EthereumSignTxEIP1559OneKey, value },
          EthereumTxRequestOneKey,
        );
        return await finishTransaction(
          exchange,
          first,
          data.subarray(initialChunk.length),
          0,
          false,
        );
      }
      case "eip7702": {
        if (!supports(info, "evm-7702")) {
          throw unsupported("device firmware does not sign eip7702 transactions");
        }
        const supplied = options?.authorization;
        if (
          supplied !== undefined &&
          ((supplied.yParity !== 0 && supplied.yParity !== 1) ||
            supplied.r.length !== 32 ||
            supplied.s.length !== 32)
        ) {
          throw invalid("authorization signature must be { yParity: 0|1, r: 32B, s: 32B }");
        }
        const value = {
          addressN: [...path],
          nonce: minimalBytes(BigInt(tx.nonce)),
          maxGasFee: quantity(tx.maxFeePerGas),
          maxPriorityFee: quantity(tx.maxPriorityFeePerGas),
          gasLimit: quantity(tx.gas),
          to: tx.to,
          value: quantity(tx.value),
          dataInitialChunk: initialChunk,
          dataLength: data.length,
          chainId: BigInt(tx.chainId),
          accessList: tx.accessList.map((entry) => ({
            address: entry.address,
            storageKeys: entry.storageKeys.map(hexBytes),
          })),
          // The self-sponsored authorization the plan models: same path, the transaction's
          // chain id, nonce + 1; stage 2 supplies the stage-1 signature — both firmwares
          // refuse an item carrying address_n AND signature (sign_tx_eip7702.py
          // check_common_fields, ethereum_onekey.c ethereum_check_authorization_list).
          authorizationList: [
            {
              ...(supplied === undefined ? { addressN: [...path] } : {}),
              chainId: BigInt(tx.chainId),
              address: tx.authorization.address,
              nonce: minimalBytes(BigInt(tx.nonce) + 1n),
              ...(supplied === undefined ? {} : { signature: supplied }),
            },
          ],
        };
        const first = await call(
          exchange,
          { def: EthereumSignTxEIP7702OneKey, value },
          EthereumTxRequestOneKey,
        );
        return await finishTransaction(
          exchange,
          first,
          data.subarray(initialChunk.length),
          0,
          true,
        );
      }
    }
  } catch (error) {
    if (
      tx.type === "eip7702" &&
      error instanceof OneKeyError &&
      error.code === "device-error" &&
      error.failure === FAILURE_DATA_ERROR
    ) {
      throw unsupported("device refused the delegation");
    }
    throw error;
  }
}

/**
 * EIP-191 personal_sign. The device's 65-byte answer is r‖s‖v (`signature[1:] + signature[0:1]` in
 * sign_message.py); only r‖s returns — assemble recomputes the recovery id.
 */
export async function signEvmPersonalMessage(
  exchange: Exchange,
  path: ReadonlyArray<number>,
  message: Uint8Array,
  chainId?: bigint,
): Promise<Uint8Array> {
  checkPath(path);
  const response = await call(
    exchange,
    {
      def: EthereumSignMessageOneKey,
      value: {
        addressN: [...path],
        message,
        ...(chainId === undefined ? {} : { chainId }),
      },
    },
    EthereumMessageSignatureOneKey,
  );
  const { signature } = response;
  if (signature.length !== 65) {
    throw fault("personal-message signature is not 65 bytes");
  }
  return new Uint8Array(signature.subarray(0, 64));
}

// ---------------------------------------------------------------------------
// EIP-712 typed data

type TypedDoc = ReturnType<typeof parseTypedData>["json"];

/** Reads one own property of a member object without asserting its shape. */
const readProp = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

type FieldType =
  | { readonly kind: "uint" | "int"; readonly size: number }
  | { readonly kind: "bytes"; readonly size: number | undefined }
  | { readonly kind: "string" | "bool" | "address" }
  | { readonly kind: "array"; readonly entry: FieldType; readonly size: number | undefined }
  | { readonly kind: "struct"; readonly name: string };

const INT_TYPE = /^(u?int)([0-9]+)$/;
const BYTES_TYPE = /^bytes([0-9]*)$/;
const ARRAY_TYPE = /^(.*)\[([0-9]*)\]$/;

/** Parses one EIP-712 type name against the document's struct table. */
function parseType(typeName: string, doc: TypedDoc): FieldType {
  const array = ARRAY_TYPE.exec(typeName);
  if (array !== null) {
    const [, entryTypeName, sizeText] = array;
    if (entryTypeName === undefined) {
      throw invalid(`array type ${typeName} has no entry type`);
    }
    const entry = parseType(entryTypeName, doc);
    const size = sizeText === "" || sizeText === undefined ? undefined : Number(sizeText);
    if (size !== undefined && (!Number.isInteger(size) || size < 0 || size > 0xff_ff)) {
      throw invalid("array size out of range");
    }
    return { kind: "array", entry, size };
  }
  const int = INT_TYPE.exec(typeName);
  if (int !== null) {
    const bits = Number(int[2]);
    if (bits % 8 !== 0 || bits < 8 || bits > 256) {
      throw invalid(`integer type ${typeName} out of range`);
    }
    return { kind: int[1] === "uint" ? "uint" : "int", size: bits / 8 };
  }
  const bytes = BYTES_TYPE.exec(typeName);
  if (bytes !== null) {
    const size = bytes[1] === "" ? undefined : Number(bytes[1]);
    if (size !== undefined && (size < 1 || size > 32)) {
      throw invalid(`bytes type ${typeName} out of range`);
    }
    return { kind: "bytes", size };
  }
  if (typeName === "string" || typeName === "bool" || typeName === "address") {
    return { kind: typeName };
  }
  if (doc.types[typeName] !== undefined) {
    return { kind: "struct", name: typeName };
  }
  throw invalid(`unknown type ${typeName}`);
}

// EthereumDataTypeOneKey (messages-ethereum-eip712-onekey.proto, both schemas).
const DATA_TYPE = {
  uint: 1,
  int: 2,
  bytes: 3,
  string: 4,
  bool: 5,
  address: 6,
  array: 7,
  struct: 8,
};

type WireFieldType = Decoded<EthereumFieldTypeOneKeyFields>;

/** The field-type record the struct ack sends, matching validate_field_type's requirements. */
// oxlint-disable-next-line typescript/consistent-return -- every FieldType kind returns above
function wireFieldType(type: FieldType, doc: TypedDoc): WireFieldType {
  switch (type.kind) {
    case "uint":
      return { dataType: DATA_TYPE.uint, size: type.size };
    case "int":
      return { dataType: DATA_TYPE.int, size: type.size };
    case "bytes":
      return { dataType: DATA_TYPE.bytes, ...(type.size === undefined ? {} : { size: type.size }) };
    case "string":
      return { dataType: DATA_TYPE.string };
    case "bool":
      return { dataType: DATA_TYPE.bool };
    case "address":
      return { dataType: DATA_TYPE.address };
    case "array":
      return {
        dataType: DATA_TYPE.array,
        entryType: wireFieldType(type.entry, doc),
        ...(type.size === undefined ? {} : { size: type.size }),
      };
    case "struct": {
      // size = member count (validate_field_type requires it on structs).
      const members = doc.types[type.name];
      if (members === undefined) {
        throw invalid(`unknown struct ${type.name}`);
      }
      return {
        dataType: DATA_TYPE.struct,
        structName: type.name,
        size: members.length,
      };
    }
  }
}

/**
 * Resolves a device `member_path`: [0] walks the domain struct, [1] the message struct; each
 * further index selects a struct member by declaration index or an array element. An out-of-range
 * path is a device-fault.
 */
function resolveMember(
  doc: TypedDoc,
  path: ReadonlyArray<number>,
): { type: FieldType; value: unknown } {
  if (path.length === 0 || (path[0] !== 0 && path[0] !== 1)) {
    throw fault("typed-data member path has a bad root");
  }
  let type: FieldType = { kind: "struct", name: path[0] === 0 ? "EIP712Domain" : doc.primaryType };
  let value: unknown = path[0] === 0 ? doc.domain : doc.message;
  for (const index of path.slice(1)) {
    if (type.kind === "struct") {
      const members = doc.types[type.name];
      const member = members?.[index];
      if (member === undefined) {
        throw fault("typed-data member path is out of range");
      }
      type = parseType(member.type, doc);
      value = readProp(value, member.name);
    } else if (type.kind === "array") {
      if (!Array.isArray(value) || index >= value.length) {
        throw fault("typed-data member path is out of range");
      }
      type = type.entry;
      value = value[index];
    } else {
      throw fault("typed-data member path walks into an atomic value");
    }
  }
  return { type, value };
}

const leftPad32 = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length > 32) {
    throw invalid("value exceeds 32 bytes");
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
};

const rightPad32 = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length > 32) {
    throw invalid("bytesN value exceeds its type size");
  }
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
};

const toBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    return BigInt(value);
  }
  throw invalid("integer member is not a quantity");
};

/** The uintN/intN big-endian two's-complement at the declared byte size. */
const intBytes = (value: unknown, size: number, signed: boolean): Uint8Array => {
  const n = toBigInt(value);
  const modulus = 256n ** BigInt(size);
  let encoded = n;
  if (signed) {
    if (n < -(modulus / 2n) || n >= modulus / 2n) {
      throw invalid("int member overflows its type");
    }
    if (n < 0n) {
      encoded = n + modulus;
    }
  } else if (n < 0n || n >= modulus) {
    throw invalid("uint member overflows its type");
  }
  const bytes = minimalBytes(encoded);
  const out = new Uint8Array(size);
  out.set(bytes, size - bytes.length);
  return out;
};

const addressBytes = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw invalid("address member is not 20 bytes of hex");
  }
  return hexBytes(value);
};

const stringBytes = (value: unknown): Uint8Array => {
  if (typeof value !== "string") {
    throw invalid("string member is not a string");
  }
  return utf8ToBytes(value);
};

const bytesValue = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw invalid("bytes member is not hex");
  }
  return hexBytes(value);
};

/** The raw bytes the ValueAck carries for an atomic member (device applies the padding). */
function atomicValue(type: FieldType, value: unknown): Uint8Array {
  switch (type.kind) {
    case "uint":
      return intBytes(value, type.size, false);
    case "int":
      return intBytes(value, type.size, true);
    case "bytes": {
      const bytes = bytesValue(value);
      if (type.size !== undefined && bytes.length !== type.size) {
        throw invalid("bytesN member does not match its type size");
      }
      return bytes;
    }
    case "string":
      return stringBytes(value);
    case "bool":
      if (typeof value !== "boolean") {
        throw invalid("bool member is not a boolean");
      }
      return new Uint8Array([value ? 1 : 0]);

    case "address":
      return addressBytes(value);
    default:
      throw fault("device requested a reference type as an atomic value");
  }
}

/** The 32-byte encoding of one member inside a struct's encodeData. */
// oxlint-disable-next-line typescript/consistent-return -- every FieldType kind returns above
function encodeMember(type: FieldType, value: unknown, doc: TypedDoc): Uint8Array {
  switch (type.kind) {
    case "uint":
    case "int":
    case "bool":
    case "address":
      return leftPad32(atomicValue(type, value));
    case "bytes":
      return type.size === undefined
        ? keccak_256(atomicValue(type, value))
        : rightPad32(atomicValue(type, value));
    case "string":
      return keccak_256(atomicValue(type, value));
    case "array": {
      if (!Array.isArray(value)) {
        throw invalid("array member is not an array");
      }
      const parts = value.map((entry) => encodeMember(type.entry, entry, doc));
      return keccak_256(concatAll(parts));
    }
    case "struct":
      return hashStruct(doc, type.name, value);
  }
}

const concatAll = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** The struct types `typeName` transitively references (through arrays too), sorted. */
function structDeps(doc: TypedDoc, typeName: string, into: Set<string>): void {
  const members = doc.types[typeName];
  if (members === undefined || into.has(typeName)) {
    return;
  }
  into.add(typeName);
  for (const member of members) {
    let type = parseType(member.type, doc);
    while (type.kind === "array") {
      type = type.entry;
    }
    if (type.kind === "struct") {
      structDeps(doc, type.name, into);
    }
  }
}

/** Keccak256 of the EIP-712 `encodeType` — primary first, dependencies sorted by name. */
function typeHash(doc: TypedDoc, typeName: string): Uint8Array {
  const deps = new Set<string>();
  structDeps(doc, typeName, deps);
  deps.delete(typeName);
  const ordered = [typeName, ...[...deps].sort()];
  const encoded = ordered
    .map((name) => {
      const members = doc.types[name] ?? [];
      const fields = members.map((member) => `${member.type} ${member.name}`).join(",");
      return `${name}(${fields})`;
    })
    .join("");
  return keccak_256(utf8ToBytes(encoded));
}

/** Keccak256(encodeType ‖ encodeData) — the hashStruct the device computes in stream mode. */
function hashStruct(doc: TypedDoc, typeName: string, value: unknown): Uint8Array {
  const members = doc.types[typeName];
  if (members === undefined) {
    throw invalid(`unknown struct ${typeName}`);
  }
  return keccak_256(
    concatAll([
      typeHash(doc, typeName),
      ...members.map((member) =>
        encodeMember(parseType(member.type, doc), readProp(value, member.name), doc),
      ),
    ]),
  );
}

const MINI_MAX_STRUCT_FIELDS = 16;
const MINI_MAX_ACCESS_PATH_DEPTH = 6;
const MINI_MAX_CUSTOM_DEP_STRUCTS = 8;
const MINI_MAX_NAME_LENGTH = 63;
const MINI_MAX_DYNAMIC_VALUE_BYTES = 1536;
const MINI_MAX_ARRAY_TYPE_FIELDS = 24;
const MINI_MAX_ARRAY_ELEMENTS = 24;

/** Byte size of a dynamic (string/bytes) member value — the MINI_MAX_DYNAMIC_VALUE_BYTES input. */
const dynamicSize = (typeName: string, value: unknown): number => {
  if (typeName === "string") {
    return typeof value === "string" ? utf8ToBytes(value).length : 0;
  }
  if (BYTES_TYPE.test(typeName)) {
    try {
      return bytesValue(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
};

// EVMSignTypedData.ts:405-530 — the format violations that keep the classic family on hash mode.
function classicViolations(doc: TypedDoc): boolean {
  const typeList = Object.values(doc.types);
  if (typeList.some((fields) => fields.length > MINI_MAX_STRUCT_FIELDS)) {
    return true;
  }
  if (
    Object.entries(doc.types).some(
      ([typeName, fields]) =>
        typeName.length > MINI_MAX_NAME_LENGTH ||
        fields.some((field) => field.name.length > MINI_MAX_NAME_LENGTH),
    )
  ) {
    return true;
  }
  const arrayFields = typeList.reduce(
    (count, fields) => count + fields.filter((field) => ARRAY_TYPE.test(field.type)).length,
    0,
  );
  if (arrayFields > MINI_MAX_ARRAY_TYPE_FIELDS) {
    return true;
  }
  const depth = (type: FieldType, visiting: ReadonlySet<string>): number => {
    if (type.kind === "array") {
      return 1 + depth(type.entry, visiting);
    }
    if (type.kind !== "struct") {
      return 1;
    }
    if (visiting.has(type.name)) {
      return MINI_MAX_ACCESS_PATH_DEPTH + 1;
    }
    const next = new Set([...visiting, type.name]);
    let max = 1;
    for (const member of doc.types[type.name] ?? []) {
      max = Math.max(max, 1 + depth(parseType(member.type, doc), next));
    }
    return max;
  };
  const maxPath =
    1 +
    Math.max(
      depth(parseType("EIP712Domain", doc), new Set()),
      depth(parseType(doc.primaryType, doc), new Set()),
    );
  if (maxPath > MINI_MAX_ACCESS_PATH_DEPTH) {
    return true;
  }
  const depStructs = new Set<string>();
  structDeps(doc, "EIP712Domain", depStructs);
  structDeps(doc, doc.primaryType, depStructs);
  depStructs.delete("EIP712Domain");
  depStructs.delete(doc.primaryType);
  if (depStructs.size > MINI_MAX_CUSTOM_DEP_STRUCTS) {
    return true;
  }
  const walk = (typeName: string, value: unknown): boolean => {
    if (value === null || value === undefined) {
      return false;
    }
    const array = ARRAY_TYPE.exec(typeName);
    if (array !== null) {
      const [, entryTypeName] = array;
      if (!Array.isArray(value) || entryTypeName === undefined) {
        return false;
      }
      const entry = parseType(entryTypeName, doc);
      // MetaMask v4 encodes each struct element individually, so struct arrays hit the same
      // element budget as primitives; only arrays-of-arrays escape it
      // (EVMSignTypedData.ts:494-516, metamaskV4Compat is always true here).
      if (value.length > MINI_MAX_ARRAY_ELEMENTS && entry.kind !== "array") {
        return true;
      }
      return value.some((item) => walk(entryTypeName, item));
    }
    if (dynamicSize(typeName, value) > MINI_MAX_DYNAMIC_VALUE_BYTES) {
      return true;
    }
    if (typeof value === "object" && doc.types[typeName] !== undefined) {
      return doc.types[typeName].some(({ name, type }) => walk(type, readProp(value, name)));
    }
    return false;
  };
  return walk("EIP712Domain", doc.domain) || walk(doc.primaryType, doc.message);
}

// EVMSignTypedData.ts:379-402 — any nested array anywhere in the document forces hash mode.
function hasNestedArrays(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(
      (entry) => Array.isArray(entry) || (typeof entry === "object" && hasNestedArrays(entry)),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasNestedArrays);
  }
  return false;
}

/**
 * Where the device parses the typed document on screen vs. signs only its digest. Mirrors the SDK
 * decision (EVMSignTypedData.ts:560-636): the classic family needs the typed-data capability and a
 * document inside its format limits; every model hashes documents with nested arrays or a
 * `message.data` field above 1024 bytes (1536 on classic1s/pure and touch/pro ≥ 4.4.0,
 * hasBiggerData).
 */
export function typedDataMode(info: DeviceInfo, typedDataJson: string): "stream" | "hash" {
  const doc = parseTypedData(typedDataJson).json;
  const classic = CLASSIC.has(info.model);
  if (classic && (!supports(info, "evm-typed-data-stream") || classicViolations(doc))) {
    return "hash";
  }
  const { data } = doc.message;
  const biggerLimit =
    info.model === "classic1s" ||
    info.model === "pure" ||
    ((info.model === "touch" || info.model === "pro") &&
      (info.firmware[0] > 4 || (info.firmware[0] === 4 && info.firmware[1] >= 4)))
      ? 1536
      : 1024;
  if (typeof data === "string") {
    const hex = data.startsWith("0x") ? 2 : 0;
    if ((data.length - hex) / 2 > biggerLimit) {
      return "hash";
    }
  }
  return hasNestedArrays(doc) ? "hash" : "stream";
}

const CLASSIC: ReadonlySet<DeviceInfo["model"]> = new Set(["classic", "classic1s", "pure", "mini"]);

/**
 * EIP-712 signing: stream mode answers the device's struct/value requests from the parsed document
 * (`metamaskV4Compat: true`, same as the SDK); hash mode ships the domain and message hashes
 * computed with the same encoder the device uses. Rounds are bounded at 4096; an unknown struct
 * name or an out-of-range member path is a device-fault. The 65-byte answer is r‖s‖v; only r‖s
 * returns.
 */
export async function signTypedData(
  exchange: Exchange,
  info: DeviceInfo,
  path: ReadonlyArray<number>,
  typedDataJson: string,
  chainId?: bigint,
): Promise<Uint8Array> {
  checkPath(path);
  const doc = parseTypedData(typedDataJson).json;
  if (doc.types["EIP712Domain"] === undefined || doc.types[doc.primaryType] === undefined) {
    throw invalid("typed data is missing EIP712Domain or the primary type");
  }
  if (typedDataMode(info, typedDataJson) === "hash") {
    const domainSeparatorHash = hashStruct(doc, "EIP712Domain", doc.domain);
    const response = await call(
      exchange,
      {
        def: EthereumSignTypedHashOneKey,
        value: {
          addressN: [...path],
          domainSeparatorHash,
          ...(doc.primaryType === "EIP712Domain"
            ? {}
            : { messageHash: hashStruct(doc, doc.primaryType, doc.message) }),
          ...(chainId === undefined ? {} : { chainId }),
        },
      },
      EthereumTypedDataSignatureOneKey,
    );
    return signature64(response.signature);
  }
  const first = await call(
    exchange,
    {
      def: EthereumSignTypedDataOneKey,
      value: {
        addressN: [...path],
        primaryType: doc.primaryType,
        metamaskV4Compat: true,
        ...(chainId === undefined ? {} : { chainId }),
      },
    },
    TYPED_DATA_REPLIES,
  );
  return typedDataRound(exchange, doc, asTypedDataReply(first), 0);
}

const TYPED_DATA_REPLIES = [
  EthereumTypedDataStructRequestOneKey,
  EthereumTypedDataValueRequestOneKey,
  EthereumTypedDataSignatureOneKey,
] as const;

type TypedDataReply = Decoded<typeof EthereumTypedDataStructRequestOneKey.fields> &
  Decoded<typeof EthereumTypedDataValueRequestOneKey.fields> &
  Decoded<typeof EthereumTypedDataSignatureOneKey.fields>;

/** Narrows a reply already decoded against the three accepted defs to their union view. */
const asTypedDataReply = (response: Decoded<Fields>): TypedDataReply =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  response as TypedDataReply;

async function typedDataRound(
  exchange: Exchange,
  doc: TypedDoc,
  response: TypedDataReply,
  round: number,
): Promise<Uint8Array> {
  if (round >= MAX_ROUNDS) {
    throw fault("typed-data exchange exceeded the round bound");
  }
  if (response.signature !== undefined) {
    return signature64(response.signature);
  }
  if (response.name !== undefined) {
    const members = doc.types[response.name];
    if (members === undefined) {
      throw fault("device requested an unknown struct name");
    }
    const next = await call(
      exchange,
      {
        def: EthereumTypedDataStructAckOneKey,
        value: {
          members: members.map((member) => ({
            type: wireFieldType(parseType(member.type, doc), doc),
            name: member.name,
          })),
        },
      },
      TYPED_DATA_REPLIES,
    );
    return typedDataRound(exchange, doc, asTypedDataReply(next), round + 1);
  }
  if (response.memberPath !== undefined) {
    const { type, value } = resolveMember(doc, response.memberPath);
    let bytes: Uint8Array;
    if (type.kind === "array") {
      if (!Array.isArray(value)) {
        throw invalid("array member is not an array");
      }
      bytes = new Uint8Array(2);
      new DataView(bytes.buffer).setUint16(0, value.length);
    } else {
      bytes = atomicValue(type, value);
    }
    const next = await call(
      exchange,
      { def: EthereumTypedDataValueAckOneKey, value: { value: bytes } },
      TYPED_DATA_REPLIES,
    );
    return typedDataRound(exchange, doc, asTypedDataReply(next), round + 1);
  }
  throw fault("typed-data response was none of the expected types");
}

function signature64(signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) {
    throw fault("typed-data signature is not 65 bytes");
  }
  return new Uint8Array(signature.subarray(0, 64));
}

// ---------------------------------------------------------------------------
// Display classification

export type EvmDisplayRequest =
  | { readonly kind: "evm.transaction"; readonly tx: EvmTransaction }
  | { readonly kind: "evm.personal-message" }
  | { readonly kind: "evm.typed-data"; readonly typedData: string };

// The ERC-20 selectors both firmwares special-case (Pro sign_tx.py handle_approve,
// Classic 1S ethereum_onekey.c is_erc20_approve): approve 0x095ea7b3 and
// increaseAllowance 0x39509351 — each renders spender, amount and the token contract even for
// unregistered tokens (Pro: ApproveInfo regardless of token lookup; Classic: the approve overview
// pages include the token-address screen). A plain `transfer` 0xa9059cbb stays blind: for
// unregistered tokens Classic's token page shows no contract screen (layout2.c only draws
// I__TOKEN_CONTRACT_COLON for NFT transfers) and Pro falls back to raw calldata.
const APPROVE_SELECTORS = new Set(["095ea7b3", "39509351"]);

/**
 * "clear" when the device renders the request's semantics, "blind" when it signs a digest or raw
 * bytes the user cannot fully verify on screen.
 */
// oxlint-disable-next-line typescript/consistent-return -- every request kind returns above
export function evmDisplay(info: DeviceInfo, request: EvmDisplayRequest): "clear" | "blind" {
  switch (request.kind) {
    case "evm.personal-message":
      return "clear";
    case "evm.typed-data":
      return typedDataMode(info, request.typedData) === "stream" ? "clear" : "blind";
    case "evm.transaction": {
      const { tx } = request;
      if (tx.type === "eip7702") {
        // Registered delegators are rendered with a name and delegation target; an unregistered
        // one is refused before anything meaningful displays.
        return registeredDelegator(tx.authorization.address) ? "clear" : "blind";
      }
      const data = tx.data.startsWith("0x") ? tx.data.slice(2) : tx.data;
      if (data.length === 0) {
        return "clear";
      }
      if (data.length === 136 && APPROVE_SELECTORS.has(data.slice(0, 8))) {
        return "clear";
      }
      return "blind";
    }
  }
}

// The delegation targets both firmwares carry (firmware-pro eip7702_delegators.py,
// firmware-classic1s eip7702_delegators.h): the zero revoke address, OKX, MetaMask, Simple7702.
const REGISTERED_DELEGATORS: ReadonlySet<string> = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x80296ff8d1ed46f8e3c7992664d13b833504c2bb",
  "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b",
  "0x4cd241e8d1510e30b2076397afc7508ae59c66c9",
]);

const registeredDelegator = (address: string): boolean =>
  REGISTERED_DELEGATORS.has(address.toLowerCase());
