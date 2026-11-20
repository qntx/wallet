/**
 * `Transaction.raw` and `Transaction` wire codec (Tron.proto:335-451). The raw message carries
 * exactly one contract — `contract` is `repeated` on the wire only for historical reasons ("only
 * support size = 1"), so zero or two is malformed rather than blind. TaPoS fields (`ref_block_num`,
 * `auths`, `scripts`) and any unknown field are captured verbatim in `extra` for blind
 * classification; `Contract.provider`/`ContractName` likewise on the contract. Every accepted input
 * satisfies `encodeTronRawData(decodeTronRawData(b)) == b`; a non-canonical encoding — an
 * explicitly-encoded default among them — is malformed.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import { tronContractType, tronTypeUrl } from "./contract-types.ts";
import {
  bytesField,
  collectExtra,
  encodeMessage,
  equalBytes,
  malformed,
  readFields,
  requiredBytesField,
  stringField,
  varintField,
} from "./proto.ts";
import type { ProtoExtra, ProtoField } from "./proto.ts";

/** One `Contract` slot: the Any's two fields unwrapped, extras captured verbatim. */
export type TronContractSlot = {
  readonly typeId: number;
  readonly typeUrl: string;
  readonly value: Uint8Array;
  readonly permissionId: number;
  readonly extra: ProtoExtra;
};

export type TronRawData = {
  readonly refBlockBytes: Uint8Array;
  readonly refBlockHash: Uint8Array;
  readonly expiration: bigint;
  readonly timestamp?: bigint;
  readonly feeLimit?: bigint;
  /** Field 10 `data` — the user memo. */
  readonly memo?: Uint8Array;
  readonly contract: TronContractSlot;
  readonly extra: ProtoExtra;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

const field = (fs: ReadonlyArray<ProtoField>, n: number): ProtoField | undefined =>
  fs.find((f) => f.field === n);

const all = (fs: ReadonlyArray<ProtoField>, n: number): ReadonlyArray<ProtoField> =>
  fs.filter((f) => f.field === n);

const int64Field = (f: ProtoField | undefined, what: string): bigint => {
  if (f === undefined) {
    return 0n;
  }
  if (f.wire !== 0 || f.varint === undefined) {
    malformed(`${what} has the wrong wire type`);
  }
  if (f.varint >= 0x8000000000000000n) {
    malformed(`${what} is negative`);
  }
  return f.varint;
};

const int32Field = (f: ProtoField | undefined, what: string): number => {
  const v = int64Field(f, what);
  if (v > 0x7fffffffn) {
    malformed(`${what} exceeds int32`);
  }
  return Number(v);
};

const bytesFieldOf = (f: ProtoField | undefined, what: string): Uint8Array => {
  if (f === undefined || f.wire !== 2 || f.data === undefined) {
    malformed(`${what} is missing`);
  }
  return f.data;
};

const encodeAny = (typeUrl: string, value: Uint8Array): Uint8Array =>
  encodeMessage([
    { field: 1, bytes: stringField(1, typeUrl) },
    { field: 2, bytes: bytesField(2, value) },
  ]);

const encodeContract = (contract: TronContractSlot): Uint8Array =>
  encodeMessage([
    { field: 1, bytes: varintField(1, contract.typeId) },
    { field: 2, bytes: requiredBytesField(2, encodeAny(contract.typeUrl, contract.value)) },
    ...contract.extra.map((e) => ({ field: e.field, bytes: e.bytes })),
    { field: 5, bytes: varintField(5, contract.permissionId) },
  ]);

const decodeContract = (bytes: Uint8Array): TronContractSlot => {
  const fs = readFields(bytes);
  const typeF = field(fs, 1);
  const typeId = int32Field(typeF, "Contract.type");
  const parameter = bytesFieldOf(field(fs, 2), "Contract.parameter");
  const permissionId = int32Field(field(fs, 5), "Permission_id");
  // google.protobuf.Any is a well-known two-field message: type_url then value, nothing else.
  const any = readFields(parameter);
  if (any.some((f) => f.field !== 1 && f.field !== 2)) {
    malformed("google.protobuf.Any holds a field beyond type_url and value");
  }
  const urlBytes = bytesFieldOf(field(any, 1), "Any.type_url");
  const value = bytesFieldOf(field(any, 2), "Any.value");
  let typeUrl: string;
  try {
    typeUrl = utf8.decode(urlBytes);
  } catch {
    return malformed("Any.type_url is not UTF-8");
  }
  const known = tronContractType(typeId);
  if (known !== undefined && typeUrl !== tronTypeUrl(known.name)) {
    malformed(`type_url ${typeUrl} does not name ${known.name}`);
  }
  return {
    typeId,
    typeUrl,
    value,
    permissionId,
    extra: collectExtra(fs, [1, 2, 5]),
  };
};

export const decodeTronRawData = (bytes: Uint8Array): TronRawData => {
  const fs = readFields(bytes, [9, 11]);
  const refBlockBytes = bytesFieldOf(field(fs, 1), "ref_block_bytes");
  if (refBlockBytes.length !== 2) {
    malformed("ref_block_bytes is not 2 bytes");
  }
  const refBlockHash = bytesFieldOf(field(fs, 4), "ref_block_hash");
  if (refBlockHash.length !== 8) {
    malformed("ref_block_hash is not 8 bytes");
  }
  const expiration = int64Field(field(fs, 8), "expiration");
  if (expiration === 0n) {
    malformed("expiration is missing");
  }
  const memo = field(fs, 10);
  const contracts = all(fs, 11);
  if (contracts.length !== 1) {
    malformed(`raw_data carries ${contracts.length} contracts, exactly one is supported`);
  }
  const contract = decodeContract(bytesFieldOf(contracts[0], "contract"));
  const timestamp = field(fs, 14);
  const feeLimit = field(fs, 18);
  const raw: TronRawData = {
    refBlockBytes,
    refBlockHash,
    expiration,
    ...(timestamp === undefined ? {} : { timestamp: int64Field(timestamp, "timestamp") }),
    ...(feeLimit === undefined ? {} : { feeLimit: int64Field(feeLimit, "fee_limit") }),
    ...(memo === undefined ? {} : { memo: bytesFieldOf(memo, "data") }),
    contract,
    extra: collectExtra(fs, [1, 4, 8, 10, 11, 14, 18]),
  };
  if (!equalBytes(encodeTronRawData(raw), bytes)) {
    malformed("non-canonical encoding");
  }
  return raw;
};

export const encodeTronRawData = (raw: TronRawData): Uint8Array =>
  encodeMessage([
    { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
    ...raw.extra.map((e) => ({ field: e.field, bytes: e.bytes })),
    { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
    { field: 8, bytes: varintField(8, raw.expiration) },
    { field: 10, bytes: bytesField(10, raw.memo ?? new Uint8Array(0)) },
    { field: 11, bytes: requiredBytesField(11, encodeContract(raw.contract)) },
    { field: 14, bytes: varintField(14, raw.timestamp ?? 0n) },
    { field: 18, bytes: varintField(18, raw.feeLimit ?? 0n) },
  ]);

/** TxID = sha256 over the canonical raw_data bytes — the transaction's only id. */
export const tronTransactionId = (rawData: Uint8Array): Uint8Array => sha256(rawData);

/** Transaction { raw_data = 1; repeated bytes signature = 2 } — the broadcast envelope. */
export const encodeTronTransaction = (
  rawData: Uint8Array,
  signatures: ReadonlyArray<Uint8Array>,
): Uint8Array =>
  encodeMessage([
    { field: 1, bytes: requiredBytesField(1, rawData) },
    ...signatures.map((s) => ({ field: 2, bytes: requiredBytesField(2, s) })),
  ]);
