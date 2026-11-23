/**
 * The Keystone UR registry bodies. The `@qntx/ur` codecs own every type they cover — the eth / sol
 * / tron sign requests and signatures, `crypto-multi-accounts` and `crypto-psbt` — and this module
 * adapts them to the driver's field shape: BIP-32 paths carrying hardened bits, byte-array
 * fingerprints and the numeric data-type enums the call sites use. The three types the library
 * lacks — `btc-sign-request`, `btc-signature` and the `qr-hardware-call` key-derivation request —
 * are local `UrCodec`s over the same dcbor runtime, so the kernel keeps exactly one CBOR
 * implementation. Field numbers and tags mirror the Rust encoders exactly
 * (ethereum/eth_sign_request.rs, solana/sol_sign_request.rs, tron/tron_sign_request.rs,
 * bitcoin/btc_sign_request.rs, crypto_psbt.rs): the keypath `depth` field and the address fields
 * are omitted, and `origin` is always written.
 *
 * One error boundary: anything a codec or dcbor raises while decoding or encoding — `CborError`,
 * `UrError`, the host `RangeError` of a stack-exhausting nest — maps to `KernelError("integrity")`;
 * nothing untyped escapes.
 */
import {
  CborError,
  CborMap,
  Tag,
  asUnsigned,
  cbor,
  decodeCbor,
  encodeCbor,
  expectArray,
  expectBytes,
  expectMap,
  expectTaggedContent,
  expectText,
  expectUnsigned,
  extractTaggedContent,
  taggedValue,
  validateTag,
} from "@blockchaincommons/dcbor";
import type { Cbor } from "@blockchaincommons/dcbor";

import {
  cryptoMultiAccountsCodec,
  ethSignRequestCodec,
  solSignRequestCodec,
  tronSignRequestCodec,
} from "@qntx/ur/interop";
import type {
  EthDataType,
  Keypath,
  MultiAccounts,
  SolSignType,
  TronDataType,
  UrCodec,
} from "@qntx/ur/interop";
import { cryptoKeypathCodec } from "@qntx/ur/registry";
import type { KeyPath } from "@qntx/wallet-chains";

import { KernelError } from "../../../errors.ts";

export const TAG_UUID: Tag = Tag.from(37, "uuid");
const TAG_BTC_SIGN_REQUEST = Tag.from(8101, "btc-sign-request");
const TAG_BTC_SIGNATURE = Tag.from(8102, "btc-signature");
const TAG_QR_HARDWARE_CALL = Tag.from(1201, "qr-hardware-call");
const TAG_KEY_DERIVATION_CALL = Tag.from(1301, "key-derivation-call");
const TAG_KEY_DERIVATION_SCHEMA = Tag.from(1302, "key-derivation-schema");

function fail(): never {
  throw new KernelError("integrity", "malformed registry item");
}

/** Untrusted device bytes through one codec; every library failure is `integrity`. */
export const decodeRegistry = <T>(bytes: Uint8Array, codec: UrCodec<T>): T => {
  try {
    // QR payloads are already transport-bounded; the decoder re-asserts the cap.
    if (bytes.length === 0 || bytes.length > 262_144) {
      fail();
    }
    return codec.decode(decodeCbor(bytes));
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    return fail();
  }
};

const encodeRegistry = <T>(value: T, codec: UrCodec<T>): Uint8Array => {
  try {
    return encodeCbor(codec.encode(value));
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    return fail();
  }
};

const HARDENED_BIT = 0x80000000;

/** The BIP-32 `path` as a concrete registry keypath carrying the master fingerprint. */
const derivationPath = (path: KeyPath, fingerprint: Uint8Array): Keypath => {
  if (fingerprint.length !== 4) {
    fail();
  }
  return {
    components: path.map((component) => ({
      kind: "index" as const,
      index: component % HARDENED_BIT,
      hardened: component >= HARDENED_BIT,
    })),
    sourceFingerprint: new DataView(fingerprint.buffer, fingerprint.byteOffset, 4).getUint32(0),
  };
};

/** The map of a registry body: integer keys drawn only from `keys`, nothing else admitted. */
const closedIntMap = (value: Cbor, keys: ReadonlySet<number>): CborMap => {
  const map = expectMap(value);
  if (map.size > keys.size) {
    throw CborError.outOfRange();
  }
  for (const { key } of map.entriesArray) {
    const n = asUnsigned(key);
    if (typeof n !== "number" || !keys.has(n)) {
      throw CborError.wrongType();
    }
  }
  return map;
};

const uint = (value: Cbor): number => {
  const n = expectUnsigned(value);
  if (typeof n !== "number") {
    throw CborError.outOfRange();
  }
  return n;
};

/** `text` under `key`, written unless empty — absent encodes as absent, as every vendor does. */
const optionalText = (map: CborMap, key: number): string | undefined => {
  const value = map.get(key);
  if (value === undefined) {
    return undefined;
  }
  const text = expectText(value);
  return text === "" ? undefined : text;
};

const requestIdTagged = (requestId: Uint8Array): Cbor => {
  if (requestId.length !== 16) {
    throw CborError.outOfRange();
  }
  return taggedValue(TAG_UUID, cbor(requestId));
};

const requestIdOf = (value: Cbor): Uint8Array => {
  const id = expectBytes(expectTaggedContent(value, TAG_UUID));
  if (id.length !== 16) {
    throw CborError.outOfRange();
  }
  return id;
};

/** What every sign request shares: the request id, the payload bytes, the origin string. */
export type SignRequestFields = {
  readonly requestId: Uint8Array;
  readonly signData: Uint8Array;
  readonly fingerprint: Uint8Array;
  readonly origin: string;
};

const ETH_DATA_TYPE: Readonly<Record<1 | 2 | 3 | 4, EthDataType>> = {
  1: "transaction",
  2: "typedData",
  3: "personalMessage",
  4: "typedTransaction",
};

export const ethSignRequest = (
  fields: SignRequestFields & {
    readonly dataType: 1 | 2 | 3 | 4;
    readonly chainId?: number;
    readonly path: KeyPath;
  },
): Uint8Array =>
  encodeRegistry(
    {
      requestId: fields.requestId,
      signData: fields.signData,
      dataType: ETH_DATA_TYPE[fields.dataType],
      ...(fields.chainId === undefined ? {} : { chainId: fields.chainId }),
      derivationPath: derivationPath(fields.path, fields.fingerprint),
      origin: fields.origin,
    },
    ethSignRequestCodec,
  );

const SOL_SIGN_TYPE: Readonly<Record<1 | 2, SolSignType>> = {
  1: "transaction",
  2: "message",
};

export const solSignRequest = (
  fields: SignRequestFields & { readonly signType: 1 | 2; readonly path: KeyPath },
): Uint8Array =>
  encodeRegistry(
    {
      requestId: fields.requestId,
      signData: fields.signData,
      derivationPath: derivationPath(fields.path, fields.fingerprint),
      origin: fields.origin,
      signType: SOL_SIGN_TYPE[fields.signType],
    },
    solSignRequestCodec,
  );

const TRON_DATA_TYPE: Readonly<Record<1 | 2, TronDataType>> = {
  1: "transaction",
  2: "messageV2",
};

export const tronSignRequest = (
  fields: SignRequestFields & { readonly dataType: 1 | 2; readonly path: KeyPath },
): Uint8Array =>
  encodeRegistry(
    {
      requestId: fields.requestId,
      signData: fields.signData,
      dataType: TRON_DATA_TYPE[fields.dataType],
      derivationPath: derivationPath(fields.path, fields.fingerprint),
      origin: fields.origin,
    },
    tronSignRequestCodec,
  );

/** Signature answers carry the request id under `#6.37` — present or absent per vendor build. */
const optionalRequestId = (map: CborMap): Uint8Array | undefined => {
  const value = map.get(1);
  return value === undefined ? undefined : requestIdOf(value);
};

export type { MultiAccounts } from "@qntx/ur/interop";

export const multiAccounts = (bytes: Uint8Array): MultiAccounts =>
  decodeRegistry(bytes, cryptoMultiAccountsCodec);

// `crypto-psbt` also stays local: the library codec validates the PSBT magic
// (`psbt\xff`), but BCR-2020-007 types it as a plain byte string and the vendor
// encoders emit arbitrary bytes, so the check would break byte-identity.
const TAG_CRYPTO_PSBT = Tag.from(310, "crypto-psbt");

export type CryptoPsbt = {
  readonly bytes: Uint8Array;
};

export const cryptoPsbtCodec: UrCodec<CryptoPsbt> = {
  tags: [TAG_CRYPTO_PSBT],
  encode: ({ bytes }) => cbor(bytes),
  decode: (value) => {
    const bytes = expectBytes(value);
    if (bytes.length === 0) {
      throw CborError.outOfRange();
    }
    return { bytes };
  },
};

/** A `crypto-psbt` payload is the PSBT byte string — the UR type carries tag 310. */
export const cryptoPsbt = (psbt: Uint8Array): Uint8Array =>
  encodeRegistry({ bytes: psbt }, cryptoPsbtCodec);

// The three Keystone types @qntx/ur has no codec for stay local.

const BTC_SIGN_REQUEST_KEYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);
const BTC_SIGNATURE_KEYS: ReadonlySet<number> = new Set([1, 2, 3]);
const HARDWARE_CALL_KEYS: ReadonlySet<number> = new Set([1, 2, 3]);
const KEY_DERIVATION_CALL_KEYS: ReadonlySet<number> = new Set([1]);
const KEY_DERIVATION_SCHEMA_KEYS: ReadonlySet<number> = new Set([1, 2, 3]);

/** A concrete keypath — index components only — written `#6.304`. */
const keypathTagged = (path: Keypath): Cbor => {
  if (
    path.components.length === 0 ||
    path.components.some((component) => component.kind !== "index")
  ) {
    throw CborError.outOfRange();
  }
  return taggedValue(cryptoKeypathCodec.tags[0], cryptoKeypathCodec.encode(path));
};

const concreteKeypath = (value: Cbor): Keypath => {
  validateTag(value, [...cryptoKeypathCodec.tags]);
  const path = cryptoKeypathCodec.decode(extractTaggedContent(value));
  if (
    path.components.length === 0 ||
    path.components.some((component) => component.kind !== "index")
  ) {
    throw CborError.outOfRange();
  }
  return path;
};

/** `btc-sign-request` (tag 8101): message signing — `dataType` 1 is the only kind the wire uses. */
export type BtcSignRequest = {
  readonly requestId?: Uint8Array;
  readonly signData: Uint8Array;
  readonly derivationPaths: ReadonlyArray<Keypath>;
  readonly origin?: string;
};

export const btcSignRequestCodec: UrCodec<BtcSignRequest> = {
  tags: [TAG_BTC_SIGN_REQUEST],
  encode(request) {
    const map = new CborMap();
    if (request.requestId !== undefined) {
      map.set(1, requestIdTagged(request.requestId));
    }
    map.set(2, cbor(request.signData));
    map.set(3, 1);
    map.set(4, cbor(request.derivationPaths.map((path) => keypathTagged(path))));
    if (request.origin !== undefined && request.origin !== "") {
      map.set(6, request.origin);
    }
    return cbor(map);
  },
  decode(value) {
    const map = closedIntMap(value, BTC_SIGN_REQUEST_KEYS);
    if (uint(map.getOrThrow(3)) !== 1) {
      throw CborError.outOfRange();
    }
    const requestId = optionalRequestId(map);
    const origin = optionalText(map, 6);
    return {
      ...(requestId === undefined ? {} : { requestId }),
      signData: expectBytes(map.getOrThrow(2)),
      derivationPaths: expectArray(map.getOrThrow(4)).map(concreteKeypath),
      ...(origin === undefined ? {} : { origin }),
    };
  },
};

export const btcSignRequest = (
  fields: SignRequestFields & { readonly paths: ReadonlyArray<KeyPath> },
): Uint8Array =>
  encodeRegistry(
    {
      requestId: fields.requestId,
      signData: fields.signData,
      derivationPaths: fields.paths.map((path) => derivationPath(path, fields.fingerprint)),
      origin: fields.origin,
    },
    btcSignRequestCodec,
  );

/**
 * `btc-signature` (tag 8102): `{1 request-id, 2 signature, 3 public-key}` — 65-byte compact
 * header‖r‖s and the 33-byte compressed signer key.
 */
export type BtcSignature = {
  readonly requestId: Uint8Array | undefined;
  readonly signature: Uint8Array;
  readonly publicKey: Uint8Array;
};

export const btcSignatureCodec: UrCodec<BtcSignature> = {
  tags: [TAG_BTC_SIGNATURE],
  encode(signature) {
    const map = new CborMap();
    if (signature.requestId !== undefined) {
      map.set(1, requestIdTagged(signature.requestId));
    }
    const signatureBytes = signature.signature;
    if (signatureBytes.length !== 65 || signature.publicKey.length !== 33) {
      throw CborError.outOfRange();
    }
    map.set(2, cbor(signatureBytes));
    map.set(3, cbor(signature.publicKey));
    return cbor(map);
  },
  decode(value) {
    const map = closedIntMap(value, BTC_SIGNATURE_KEYS);
    const signature = expectBytes(map.getOrThrow(2));
    const publicKey = expectBytes(map.getOrThrow(3));
    if (signature.length !== 65 || publicKey.length !== 33) {
      throw CborError.outOfRange();
    }
    return { requestId: optionalRequestId(map), signature, publicKey };
  },
};

type DerivationSchema = {
  readonly path: Keypath;
  /** 0 secp256k1 / 1 ed25519 — the two curves the wallet asks to derive. */
  readonly curve: 0 | 1;
};

const derivationSchemaTagged = (schema: DerivationSchema): Cbor => {
  const map = new CborMap();
  map.set(1, keypathTagged(schema.path));
  map.set(2, schema.curve);
  // 0 = slip10 — the only algo this wallet requests.
  map.set(3, 0);
  return taggedValue(TAG_KEY_DERIVATION_SCHEMA, cbor(map));
};

/**
 * A `qr-hardware-call` key-derivation request (tag 1201): call-type 0, a #1301 key-derivation-call
 * wrapping the schemas and the wallet origin string. Version stays absent — V0 is the default every
 * client sends, which is what firmware 3.2.2 parses.
 */
export type QrHardwareCall = {
  readonly schemas: ReadonlyArray<DerivationSchema>;
  readonly origin?: string;
};

export const qrHardwareCallCodec: UrCodec<QrHardwareCall> = {
  tags: [TAG_QR_HARDWARE_CALL],
  encode(request) {
    const call = new CborMap();
    call.set(1, cbor(request.schemas.map(derivationSchemaTagged)));
    const map = new CborMap();
    map.set(1, 0);
    map.set(2, taggedValue(TAG_KEY_DERIVATION_CALL, cbor(call)));
    if (request.origin !== undefined && request.origin !== "") {
      map.set(3, request.origin);
    }
    return cbor(map);
  },
  decode(value) {
    const map = closedIntMap(value, HARDWARE_CALL_KEYS);
    if (uint(map.getOrThrow(1)) !== 0) {
      throw CborError.outOfRange();
    }
    const call = closedIntMap(
      expectTaggedContent(map.getOrThrow(2), TAG_KEY_DERIVATION_CALL),
      KEY_DERIVATION_CALL_KEYS,
    );
    const schemas = expectArray(call.getOrThrow(1)).map((item): DerivationSchema => {
      const schema = closedIntMap(
        expectTaggedContent(item, TAG_KEY_DERIVATION_SCHEMA),
        KEY_DERIVATION_SCHEMA_KEYS,
      );
      const curve = uint(schema.getOrThrow(2));
      if (curve !== 0 && curve !== 1) {
        throw CborError.outOfRange();
      }
      if (uint(schema.getOrThrow(3)) !== 0) {
        throw CborError.outOfRange();
      }
      return { path: concreteKeypath(schema.getOrThrow(1)), curve };
    });
    const origin = optionalText(map, 3);
    return { schemas, ...(origin === undefined ? {} : { origin }) };
  },
};

export const hardwareCall = (fields: {
  readonly secp256k1: ReadonlyArray<KeyPath>;
  readonly ed25519: ReadonlyArray<KeyPath>;
  readonly fingerprint: Uint8Array;
  readonly origin: string;
}): Uint8Array =>
  encodeRegistry(
    {
      schemas: [
        ...fields.secp256k1.map((path): DerivationSchema => ({
          path: derivationPath(path, fields.fingerprint),
          curve: 0,
        })),
        ...fields.ed25519.map((path): DerivationSchema => ({
          path: derivationPath(path, fields.fingerprint),
          curve: 1,
        })),
      ],
      origin: fields.origin,
    },
    qrHardwareCallCodec,
  );
