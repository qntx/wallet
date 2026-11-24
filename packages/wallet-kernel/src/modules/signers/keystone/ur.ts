/**
 * The Keystone driver's UR codecs on `@qntx/ur`'s typed layer. The pairing sync, the signatures and
 * `crypto-psbt` decode through the library's registry and interop codecs; the two wire formats it
 * does not carry are the local `UrCodec`s here — `btc-sign-request`/`btc-signature` (tags
 * 8101/8102, ur-registry 1.0.9 bitcoin/btc_sign_request.rs) and the `qr-hardware-call`
 * key-derivation request (1201, `@keystonehq/bc-ur-registry` extended/QRHardwareCall). Like the
 * library's interop codecs the local maps are closed, tagged items are validated, and every field
 * length is exact.
 *
 * `decodeUr` is the only entry device bytes reach: it re-asserts the payload bound the protocol
 * already applies, then folds every decode failure — a dcbor `CborError`, a library `UrError`, the
 * host `RangeError` hostile nesting can raise — into `KernelError("integrity")`. An encode failure
 * means the request the kernel built was malformed and closes the same way; no untyped error ever
 * escapes this module.
 */
import {
  CborError,
  CborMap,
  MajorType,
  Tag,
  cbor,
  expectArray,
  expectBytes,
  expectMap,
  expectText,
  expectUnsigned,
  extractTaggedContent,
  taggedValue,
  validateTag,
} from "@blockchaincommons/dcbor";
import type { Cbor } from "@blockchaincommons/dcbor";

import { cryptoKeypathCodec } from "@qntx/ur/registry";
import type { Keypath } from "@qntx/ur/registry";
import { Ur, fromUr, toUr } from "@qntx/ur/typed";
import type { UrCodec } from "@qntx/ur/typed";
import type { KeyPath } from "@qntx/wallet-chains";

import { KernelError } from "../../../errors.ts";

/** Device answers are QR payloads — the protocol already bounds them; the decode re-asserts. */
const MAX_BYTES = 262_144;

const UUID_TAG = Tag.from(37, "uuid");
const UUID_LEN = 16;
const [KEYPATH_TAG] = cryptoKeypathCodec.tags;
const HARDENED = 0x80000000;

function integrity(): never {
  throw new KernelError("integrity", "malformed device UR exchange");
}

/** DCBOR `bytes` carried by UR `type`, decoded by `codec`; every failure is `integrity`. */
export const decodeUr = <T>(type: string, bytes: Uint8Array, codec: UrCodec<T>): T => {
  try {
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      throw CborError.outOfRange();
    }
    return fromUr(Ur.fromCborData(type, bytes), codec);
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    throw new KernelError("integrity", "malformed device UR exchange");
  }
};

/** `codec`'s untagged dCBOR body for `value`; a malformed request build is `integrity`. */
export const encodeUr = <T>(value: T, codec: UrCodec<T>): Uint8Array => {
  try {
    return toUr(value, codec).toCborData();
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    throw new KernelError("integrity", "malformed device UR exchange");
  }
};

/** A BIP-32 master fingerprint as its uint32 wire form (the registry's `sourceFingerprint`). */
export const fingerprintNumber = (fingerprint: Uint8Array): number => {
  if (fingerprint.length !== 4) {
    integrity();
  }
  return new DataView(fingerprint.buffer, fingerprint.byteOffset, 4).getUint32(0);
};

/** A uint32 wire fingerprint back to its four big-endian bytes. */
export const fingerprintBytes = (fingerprint: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, fingerprint);
  return out;
};

/** The `crypto-keypath` a sign or derivation request carries: index steps plus the fingerprint. */
export const requestKeypath = (path: KeyPath, fingerprint: Uint8Array): Keypath => ({
  components: path.map((component) => ({
    kind: "index" as const,
    index: component % HARDENED,
    hardened: component >= HARDENED,
  })),
  sourceFingerprint: fingerprintNumber(fingerprint),
});

const requestIdTagged = (requestId: Uint8Array): Cbor => {
  if (requestId.length !== UUID_LEN) {
    throw CborError.outOfRange();
  }
  return taggedValue(UUID_TAG, cbor(new Uint8Array(requestId)));
};

const readRequestId = (value: Cbor): Uint8Array => {
  validateTag(value, [UUID_TAG]);
  const bytes = expectBytes(extractTaggedContent(value));
  if (bytes.length !== UUID_LEN) {
    throw CborError.outOfRange();
  }
  return new Uint8Array(bytes);
};

/** A signing path is concrete: at least one component, every one an index step. */
const assertConcretePath = (path: Keypath): Keypath => {
  if (
    path.components.length === 0 ||
    path.components.some((component) => component.kind !== "index")
  ) {
    throw CborError.outOfRange();
  }
  return path;
};

const derivationPathTagged = (path: Keypath): Cbor =>
  taggedValue(KEYPATH_TAG, cryptoKeypathCodec.encode(assertConcretePath(path)));

const readDerivationPath = (value: Cbor): Keypath => {
  validateTag(value, [...cryptoKeypathCodec.tags]);
  return assertConcretePath(cryptoKeypathCodec.decode(extractTaggedContent(value)));
};

const readNonEmptyBytes = (value: Cbor): Uint8Array => {
  const bytes = new Uint8Array(expectBytes(value));
  if (bytes.length === 0) {
    throw CborError.outOfRange();
  }
  return bytes;
};

const optionalText = (map: CborMap, key: number): string | undefined => {
  const value = map.get(key);
  if (value === undefined) {
    return undefined;
  }
  const text = expectText(value);
  return text === "" ? undefined : text;
};

const setOptionalText = (map: CborMap, key: number, text: string | undefined): void => {
  if (text !== undefined && text !== "") {
    map.set(key, text);
  }
};

/** The closed unsigned-key map every registry structure is. */
const closedIntMap = (value: Cbor, allowed: ReadonlySet<number>): CborMap => {
  const map = expectMap(value);
  for (const [key] of map) {
    const n = expectUnsigned(key);
    if (typeof n !== "number" || !Number.isInteger(n) || !allowed.has(n)) {
      throw CborError.wrongType();
    }
  }
  return map;
};

const BTC_SIGN_REQUEST_KEYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);
const BTC_SIGNATURE_KEYS: ReadonlySet<number> = new Set([1, 2, 3]);
const HARDWARE_CALL_KEYS: ReadonlySet<number> = new Set([1, 2, 3, 4]);
const KEY_DERIVATION_CALL_KEYS: ReadonlySet<number> = new Set([1]);
const KEY_DERIVATION_SCHEMA_KEYS: ReadonlySet<number> = new Set([1, 2, 3, 4]);
const BTC_MESSAGE_DATA_TYPE = 1;
const PUBLIC_KEY_LEN = 33;

const TAG_KEY_DERIVATION_CALL = Tag.from(1301, "key-derivation-call");
const TAG_KEY_DERIVATION_SCHEMA = Tag.from(1302, "key-derivation-schema");

export type BtcSignRequest = {
  readonly requestId?: Uint8Array; // 16 bytes, #6.37
  readonly signData: Uint8Array; // non-empty
  /** Each entry is written #6.304 with its own source fingerprint. */
  readonly derivationPaths: ReadonlyArray<Keypath>;
  readonly addresses?: ReadonlyArray<string>;
  readonly origin?: string; // "" encodes as absent
};

export type BtcSignature = {
  readonly requestId?: Uint8Array; // 16 bytes, #6.37
  readonly signature: Uint8Array; // compact, length-checked by the caller
  readonly publicKey: Uint8Array; // 33-byte compressed point
};

/**
 * Keystone's `btc-sign-request` (tag 8101): `{1 uuid?, 2 signData, 3 dataType, 4 [keypaths], 5
 * addresses?, 6 origin?}`. The only data type the vendor enum defines is message (1) — the driver's
 * bitcoin message signing — so both directions accept it alone.
 */
export const btcSignRequestCodec: UrCodec<BtcSignRequest> = {
  tags: [Tag.from(8101, "btc-sign-request")],
  encode(request) {
    if (request.derivationPaths.length === 0) {
      throw CborError.outOfRange();
    }
    const signData = new Uint8Array(request.signData);
    if (signData.length === 0) {
      throw CborError.outOfRange();
    }
    const map = new CborMap();
    if (request.requestId !== undefined) {
      map.set(1, requestIdTagged(request.requestId));
    }
    map.set(2, cbor(signData));
    map.set(3, BTC_MESSAGE_DATA_TYPE);
    map.set(4, request.derivationPaths.map(derivationPathTagged));
    if (request.addresses !== undefined && request.addresses.length > 0) {
      map.set(
        5,
        request.addresses.map((address) => {
          if (address === "") {
            throw CborError.outOfRange();
          }
          return address;
        }),
      );
    }
    setOptionalText(map, 6, request.origin);
    return cbor(map);
  },
  decode(value) {
    const map = closedIntMap(value, BTC_SIGN_REQUEST_KEYS);
    const requestId = map.get(1);
    const dataType = expectUnsigned(map.getOrThrow(3));
    if (dataType !== BTC_MESSAGE_DATA_TYPE) {
      throw CborError.outOfRange();
    }
    const addresses = map.get(5);
    const origin = optionalText(map, 6);
    return Object.freeze({
      ...(requestId === undefined ? {} : { requestId: readRequestId(requestId) }),
      signData: readNonEmptyBytes(map.getOrThrow(2)),
      derivationPaths: expectArray(map.getOrThrow(4)).map(readDerivationPath),
      ...(addresses === undefined
        ? {}
        : {
            addresses: expectArray(addresses).map((address) => {
              const text = expectText(address);
              if (text === "") {
                throw CborError.outOfRange();
              }
              return text;
            }),
          }),
      ...(origin === undefined ? {} : { origin }),
    });
  },
};

export const btcSignatureCodec: UrCodec<BtcSignature> = {
  tags: [Tag.from(8102, "btc-signature")],
  encode(signature) {
    const map = new CborMap();
    if (signature.requestId !== undefined) {
      map.set(1, requestIdTagged(signature.requestId));
    }
    const signatureBytes = new Uint8Array(signature.signature);
    if (signatureBytes.length === 0) {
      throw CborError.outOfRange();
    }
    map.set(2, cbor(signatureBytes));
    const publicKey = new Uint8Array(signature.publicKey);
    if (publicKey.length !== PUBLIC_KEY_LEN) {
      throw CborError.outOfRange();
    }
    map.set(3, cbor(publicKey));
    return cbor(map);
  },
  decode(value) {
    const map = closedIntMap(value, BTC_SIGNATURE_KEYS);
    const requestId = map.get(1);
    return Object.freeze({
      ...(requestId === undefined ? {} : { requestId: readRequestId(requestId) }),
      signature: readNonEmptyBytes(map.getOrThrow(2)),
      publicKey: readNonEmptyBytes(map.getOrThrow(3)),
    });
  },
};

export type KeyDerivationSchema = {
  readonly path: Keypath; // concrete, written #6.304
  readonly curve: "secp256k1" | "ed25519"; // 0 | 1
};

export type QrHardwareCall = {
  /** Call-type 0 key-derivation schemas, in request order; non-empty. */
  readonly schemas: ReadonlyArray<KeyDerivationSchema>;
  readonly origin?: string; // "" encodes as absent
};

const CURVE_WIRE: Readonly<Record<KeyDerivationSchema["curve"], number>> = {
  secp256k1: 0,
  ed25519: 1,
};

const readCurve = (value: Cbor): KeyDerivationSchema["curve"] => {
  switch (expectUnsigned(value)) {
    case 0:
      return "secp256k1";
    case 1:
      return "ed25519";
    default:
      throw CborError.outOfRange();
  }
};

const derivationSchema = (schema: KeyDerivationSchema): Cbor => {
  const map = new CborMap();
  map.set(1, derivationPathTagged(schema.path));
  map.set(2, CURVE_WIRE[schema.curve]);
  // 0 = slip10 — the only algo this wallet requests.
  map.set(3, 0);
  return taggedValue(TAG_KEY_DERIVATION_SCHEMA, cbor(map));
};

const readDerivationSchema = (value: Cbor): KeyDerivationSchema => {
  validateTag(value, [TAG_KEY_DERIVATION_SCHEMA]);
  const map = closedIntMap(extractTaggedContent(value), KEY_DERIVATION_SCHEMA_KEYS);
  const chainType = map.get(4);
  if (chainType !== undefined && chainType.type !== MajorType.ByteString) {
    throw CborError.wrongType();
  }
  if (expectUnsigned(map.getOrThrow(3)) !== 0) {
    throw CborError.outOfRange();
  }
  return {
    path: readDerivationPath(map.getOrThrow(1)),
    curve: readCurve(map.getOrThrow(2)),
  };
};

/**
 * The `qr-hardware-call` (tag 1201) the wallet sends for key derivation: `{1 callType, 2 #1301
 * key-derivation-call {1 [schemas]}, 3 origin?, 4 version?}`. Only call-type 0 exists on the wire
 * this wallet writes, and version stays absent — V0 is the default every client sends (the vendor
 * encoder drops a falsy version), which is what firmware 3.2.2 parses.
 */
export const qrHardwareCallCodec: UrCodec<QrHardwareCall> = {
  tags: [Tag.from(1201, "qr-hardware-call")],
  encode(call) {
    if (call.schemas.length === 0) {
      throw CborError.outOfRange();
    }
    const params = new CborMap();
    params.set(1, call.schemas.map(derivationSchema));
    const map = new CborMap();
    map.set(1, 0);
    map.set(2, taggedValue(TAG_KEY_DERIVATION_CALL, cbor(params)));
    setOptionalText(map, 3, call.origin);
    return cbor(map);
  },
  decode(value) {
    const map = closedIntMap(value, HARDWARE_CALL_KEYS);
    if (expectUnsigned(map.getOrThrow(1)) !== 0) {
      throw CborError.outOfRange();
    }
    validateTag(map.getOrThrow(2), [TAG_KEY_DERIVATION_CALL]);
    const params = closedIntMap(extractTaggedContent(map.getOrThrow(2)), KEY_DERIVATION_CALL_KEYS);
    const origin = optionalText(map, 3);
    return Object.freeze({
      schemas: expectArray(params.getOrThrow(1)).map(readDerivationSchema),
      ...(origin === undefined ? {} : { origin }),
    });
  },
};
