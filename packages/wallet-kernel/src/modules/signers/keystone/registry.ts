/**
 * The Keystone UR registry structures the kernel decodes: `crypto-multi-accounts` (tag 1103) and
 * the `crypto-hdkey` (303), `crypto-keypath` (304) and `crypto-coin-info` (305) inside it. Field
 * numbers and tag values follow `ur-registry` 1.0.9 (crypto_multi_accounts.rs, crypto_hd_key.rs,
 * crypto_key_path.rs, crypto_coin_info.rs): fingerprints are uint32 read big-endian, and a keypath
 * component is a flat `[index-or-empty-array, hardened-bool]` pair — the empty array is the
 * wildcard. Unknown map keys are skipped after their value parsed structurally, like the reference
 * decoder; a structural error anywhere is `integrity`.
 *
 * The signing side encodes `eth-sign-request` (401), `sol-sign-request` (1101), `tron-sign-request`
 * (5201), `btc-sign-request` (8101) and `crypto-psbt` (310), and decodes the matching `*-signature`
 * responses. As with `crypto-multi-accounts`, the UR type carries the registry tag: payloads are
 * bare maps (or, for `crypto-psbt`, the bare PSBT byte string), while embedded items keep their
 * tags — UUID `#37` on request ids and `crypto-keypath` `#304`. Field layout and optional-field
 * rules mirror the Rust encoders exactly (ethereum/ eth_sign_request.rs,
 * solana/sol_sign_request.rs, tron/tron_sign_request.rs, bitcoin/btc_sign_request.rs,
 * crypto_psbt.rs): the keypath `depth` field is omitted, address fields are omitted, and `origin`
 * is always written.
 */
import type { KeyPath } from "@qntx/wallet-chains";

import { KernelError } from "../../../errors.ts";
import type { Cbor } from "./cbor.ts";
import { encodeCbor } from "./cbor.ts";

export const TAG_UUID = 37;
export const TAG_HD_KEY = 303;
export const TAG_KEY_PATH = 304;
export const TAG_COIN_INFO = 305;
export const TAG_MULTI_ACCOUNTS = 1103;
const TAG_KEY_DERIVATION_CALL = 1301;
const TAG_KEY_DERIVATION_SCHEMA = 1302;

function fail(): never {
  throw new KernelError("integrity", "malformed registry item");
}

const uint = (value: Cbor): number => {
  if (value.kind !== "uint") {
    fail();
  }
  return value.value;
};

const bytes = (value: Cbor): Uint8Array => {
  if (value.kind !== "bytes") {
    fail();
  }
  return value.value;
};

const text = (value: Cbor): string => {
  if (value.kind !== "text") {
    fail();
  }
  return value.value;
};

const bool = (value: Cbor): boolean => {
  if (value.kind !== "bool") {
    fail();
  }
  return value.value;
};

const fingerprint = (value: Cbor): Uint8Array => {
  const n = uint(value);
  if (n > 0xffffffff) {
    fail();
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

/** `uint` keys ≤ 2^32 are the only map keys the registry uses. */
const keyOf = (value: Cbor): number => {
  if (value.kind !== "uint" || value.value > 0xffffffff) {
    fail();
  }
  return value.value;
};

const tagged = (value: Cbor, tag: number): Cbor => {
  if (value.kind !== "tag" || value.tag !== tag) {
    fail();
  }
  return value.item;
};

export type PathComponent = {
  /** `undefined` is the wildcard — encoded as an empty array. */
  readonly index: number | undefined;
  readonly hardened: boolean;
};

export type CryptoKeyPath = {
  readonly components: ReadonlyArray<PathComponent>;
  readonly sourceFingerprint: Uint8Array | undefined;
  readonly depth: number | undefined;
};

export type CryptoCoinInfo = {
  readonly coinType: number | undefined;
  readonly network: number | undefined;
};

export type CryptoHdKey = {
  readonly isMaster: boolean;
  readonly isPrivate: boolean;
  readonly key: Uint8Array | undefined;
  readonly chainCode: Uint8Array | undefined;
  readonly useInfo: CryptoCoinInfo | undefined;
  readonly origin: CryptoKeyPath | undefined;
  readonly children: CryptoKeyPath | undefined;
  readonly parentFingerprint: Uint8Array | undefined;
  readonly name: string | undefined;
  readonly note: string | undefined;
};

export type CryptoMultiAccounts = {
  readonly masterFingerprint: Uint8Array;
  readonly keys: ReadonlyArray<CryptoHdKey>;
  readonly device: string | undefined;
  readonly deviceId: string | undefined;
  readonly deviceVersion: string | undefined;
};

const keyPath = (value: Cbor): CryptoKeyPath => {
  if (value.kind !== "map") {
    fail();
  }
  let components: PathComponent[] | undefined;
  let sourceFingerprint: Uint8Array | undefined;
  let depth: number | undefined;
  for (const [key, entry] of value.entries) {
    switch (keyOf(key)) {
      case 1: {
        if (entry.kind !== "array") {
          fail();
        }
        // A flat `[index|[], hardened]` sequence — two items per component.
        const flat = entry.items;
        if (flat.length % 2 !== 0) {
          fail();
        }
        const parsed: PathComponent[] = [];
        for (let i = 0; i < flat.length; i += 2) {
          const index = flat[i];
          const flag = flat[i + 1];
          if (index === undefined || flag === undefined) {
            fail();
          }
          if (index.kind !== "uint" && !(index.kind === "array" && index.items.length === 0)) {
            fail();
          }
          parsed.push({
            index: index.kind === "uint" ? index.value : undefined,
            hardened: bool(flag),
          });
        }
        components = parsed;
        break;
      }
      case 2:
        sourceFingerprint = fingerprint(entry);
        break;
      case 3:
        depth = uint(entry);
        break;
      default:
        break;
    }
  }
  return {
    components: components ?? [],
    sourceFingerprint,
    depth,
  };
};

const coinInfo = (value: Cbor): CryptoCoinInfo => {
  if (value.kind !== "map") {
    fail();
  }
  let coinType: number | undefined;
  let network: number | undefined;
  for (const [key, entry] of value.entries) {
    switch (keyOf(key)) {
      case 1:
        coinType = uint(entry);
        break;
      case 2:
        network = uint(entry);
        break;
      default:
        break;
    }
  }
  return { coinType, network };
};

const hdKey = (value: Cbor): CryptoHdKey => {
  if (value.kind !== "map") {
    fail();
  }
  let isMaster = false;
  let isPrivate = false;
  let key: Uint8Array | undefined;
  let chainCode: Uint8Array | undefined;
  let useInfo: CryptoCoinInfo | undefined;
  let origin: CryptoKeyPath | undefined;
  let children: CryptoKeyPath | undefined;
  let parentFingerprint: Uint8Array | undefined;
  let name: string | undefined;
  let note: string | undefined;
  for (const [field, entry] of value.entries) {
    switch (keyOf(field)) {
      case 1:
        isMaster = bool(entry);
        break;
      case 2:
        isPrivate = bool(entry);
        break;
      case 3:
        key = bytes(entry);
        break;
      case 4:
        chainCode = bytes(entry);
        break;
      case 5:
        useInfo = coinInfo(tagged(entry, TAG_COIN_INFO));
        break;
      case 6:
        origin = keyPath(tagged(entry, TAG_KEY_PATH));
        break;
      case 7:
        children = keyPath(tagged(entry, TAG_KEY_PATH));
        break;
      case 8:
        parentFingerprint = fingerprint(entry);
        break;
      case 9:
        name = text(entry);
        break;
      case 10:
        note = text(entry);
        break;
      default:
        break;
    }
  }
  return {
    isMaster,
    isPrivate,
    key,
    chainCode,
    useInfo,
    origin,
    children,
    parentFingerprint,
    name,
    note,
  };
};

/**
 * The sync payload: the bare map — the UR's type already carries the `crypto-multi-accounts` tag,
 * and a device-sized payload wrapped in it again would exceed the decoder's depth cap.
 */
export const multiAccounts = (value: Cbor): CryptoMultiAccounts => {
  if (value.kind !== "map") {
    fail();
  }
  const root = value;
  let masterFingerprint: Uint8Array | undefined;
  let keys: CryptoHdKey[] | undefined;
  let device: string | undefined;
  let deviceId: string | undefined;
  let deviceVersion: string | undefined;
  for (const [key, entry] of root.entries) {
    switch (keyOf(key)) {
      case 1:
        masterFingerprint = fingerprint(entry);
        break;
      case 2:
        if (entry.kind !== "array") {
          fail();
        }
        keys = entry.items.map((item) => hdKey(tagged(item, TAG_HD_KEY)));
        break;

      case 3:
        device = text(entry);
        break;
      case 4:
        deviceId = text(entry);
        break;
      case 5:
        deviceVersion = text(entry);
        break;
      default:
        break;
    }
  }
  if (masterFingerprint === undefined || keys === undefined) {
    fail();
  }
  return { masterFingerprint, keys, device, deviceId, deviceVersion };
};

const HARDENED_BIT = 0x80000000;

const cborUint = (value: number): Cbor => ({ kind: "uint", value });
const cborBytes = (value: Uint8Array): Cbor => ({ kind: "bytes", value });
const cborText = (value: string): Cbor => ({ kind: "text", value });

const cborMap = (entries: ReadonlyArray<readonly [number, Cbor]>): Cbor => ({
  kind: "map",
  entries: entries.map(([key, value]) => [cborUint(key), value]),
});

const keyPathCbor = (path: KeyPath, fingerprint: Uint8Array): Cbor => {
  if (fingerprint.length !== 4) {
    fail();
  }
  return {
    kind: "tag",
    tag: TAG_KEY_PATH,
    item: cborMap([
      [
        1,
        {
          kind: "array",
          items: path.flatMap((component): Cbor[] => [
            cborUint(component % HARDENED_BIT),
            { kind: "bool", value: component >= HARDENED_BIT },
          ]),
        },
      ],
      [2, cborUint(new DataView(fingerprint.buffer, fingerprint.byteOffset, 4).getUint32(0))],
    ]),
  };
};

const requestIdCbor = (requestId: Uint8Array): Cbor => {
  if (requestId.length !== 16) {
    fail();
  }
  return { kind: "tag", tag: TAG_UUID, item: cborBytes(requestId) };
};

/** What every sign request shares: the request id, the payload bytes, the origin string. */
export type SignRequestFields = {
  readonly requestId: Uint8Array;
  readonly signData: Uint8Array;
  readonly fingerprint: Uint8Array;
  readonly origin: string;
};

export const ethSignRequest = (
  fields: SignRequestFields & {
    readonly dataType: 1 | 2 | 3 | 4;
    readonly chainId?: number;
    readonly path: KeyPath;
  },
): Uint8Array =>
  encodeCbor(
    cborMap([
      [1, requestIdCbor(fields.requestId)],
      [2, cborBytes(fields.signData)],
      [3, cborUint(fields.dataType)],
      ...(fields.chainId === undefined
        ? []
        : [[4, cborUint(fields.chainId)] as readonly [number, Cbor]]),
      [5, keyPathCbor(fields.path, fields.fingerprint)],
      [7, cborText(fields.origin)],
    ]),
  );

export const solSignRequest = (
  fields: SignRequestFields & { readonly signType: 1 | 2; readonly path: KeyPath },
): Uint8Array =>
  encodeCbor(
    cborMap([
      [1, requestIdCbor(fields.requestId)],
      [2, cborBytes(fields.signData)],
      [3, keyPathCbor(fields.path, fields.fingerprint)],
      [5, cborText(fields.origin)],
      [6, cborUint(fields.signType)],
    ]),
  );

export const tronSignRequest = (
  fields: SignRequestFields & { readonly dataType: 1 | 2; readonly path: KeyPath },
): Uint8Array =>
  encodeCbor(
    cborMap([
      [1, requestIdCbor(fields.requestId)],
      [2, cborBytes(fields.signData)],
      [3, cborUint(fields.dataType)],
      [4, keyPathCbor(fields.path, fields.fingerprint)],
      [6, cborText(fields.origin)],
    ]),
  );

export const btcSignRequest = (
  fields: SignRequestFields & { readonly paths: ReadonlyArray<KeyPath> },
): Uint8Array =>
  encodeCbor(
    cborMap([
      [1, requestIdCbor(fields.requestId)],
      [2, cborBytes(fields.signData)],
      [3, cborUint(1)],
      [
        4,
        {
          kind: "array",
          items: fields.paths.map((path) => keyPathCbor(path, fields.fingerprint)),
        },
      ],
      [6, cborText(fields.origin)],
    ]),
  );

/** A `crypto-psbt` payload is the bare PSBT byte string — the UR type carries tag 310. */
export const cryptoPsbt = (psbt: Uint8Array): Uint8Array => encodeCbor(cborBytes(psbt));

const derivationSchema = (path: KeyPath, curve: 0 | 1, fingerprint: Uint8Array): Cbor => ({
  kind: "tag",
  tag: TAG_KEY_DERIVATION_SCHEMA,
  item: cborMap([
    [1, keyPathCbor(path, fingerprint)],
    [2, cborUint(curve)],
    // 0 = slip10 — the only algo this wallet requests.
    [3, cborUint(0)],
  ]),
});

/**
 * A `qr-hardware-call` key-derivation request: call-type 0, #1301 key-derivation-call wrapping the
 * schemas and the wallet origin string. Version stays absent — V0 is the default every client sends
 * (the vendor encoder drops a falsy version), which is what firmware 3.2.2 parses.
 */
export const hardwareCall = (fields: {
  readonly secp256k1: ReadonlyArray<KeyPath>;
  readonly ed25519: ReadonlyArray<KeyPath>;
  readonly fingerprint: Uint8Array;
  readonly origin: string;
}): Uint8Array =>
  encodeCbor(
    cborMap([
      [1, cborUint(0)],
      [
        2,
        {
          kind: "tag",
          tag: TAG_KEY_DERIVATION_CALL,
          item: cborMap([
            [
              1,
              {
                kind: "array",
                items: [
                  ...fields.secp256k1.map((path) => derivationSchema(path, 0, fields.fingerprint)),
                  ...fields.ed25519.map((path) => derivationSchema(path, 1, fields.fingerprint)),
                ],
              },
            ],
          ]),
        },
      ],
      [3, cborText(fields.origin)],
    ]),
  );

const requestId = (entries: ReadonlyArray<readonly [Cbor, Cbor]>): Uint8Array | undefined => {
  const taggedId = entries.find(([key]) => key.kind === "uint" && key.value === 1)?.[1];
  return taggedId === undefined ? undefined : bytes(tagged(taggedId, TAG_UUID));
};

const signatureFields = (
  value: Cbor,
): { readonly requestId: Uint8Array | undefined; readonly signature: Uint8Array } => {
  if (value.kind !== "map") {
    fail();
  }
  const signature = value.entries.find(([key]) => key.kind === "uint" && key.value === 2)?.[1];
  if (signature === undefined) {
    fail();
  }
  return { requestId: requestId(value.entries), signature: bytes(signature) };
};

export const ethSignature = (
  value: Cbor,
): { requestId: Uint8Array | undefined; signature: Uint8Array } => signatureFields(value);

export const solSignature = (
  value: Cbor,
): { requestId: Uint8Array | undefined; signature: Uint8Array } => signatureFields(value);

export const tronSignature = (
  value: Cbor,
): { requestId: Uint8Array | undefined; signature: Uint8Array } => signatureFields(value);

export const btcSignature = (
  value: Cbor,
): {
  readonly requestId: Uint8Array | undefined;
  readonly signature: Uint8Array;
  readonly publicKey: Uint8Array;
} => {
  if (value.kind !== "map") {
    fail();
  }
  const publicKey = value.entries.find(([key]) => key.kind === "uint" && key.value === 3)?.[1];
  if (publicKey === undefined) {
    fail();
  }
  return { ...signatureFields(value), publicKey: bytes(publicKey) };
};

/** Decodes a `crypto-psbt` response payload: the signed PSBT byte string. */
export const cryptoPsbtBytes = (value: Cbor): Uint8Array => bytes(value);
