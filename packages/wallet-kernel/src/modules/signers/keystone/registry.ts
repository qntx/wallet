/**
 * The Keystone UR registry structures the kernel decodes: `crypto-multi-accounts` (tag 1103) and
 * the `crypto-hdkey` (303), `crypto-keypath` (304) and `crypto-coin-info` (305) inside it. Field
 * numbers and tag values follow `ur-registry` 1.0.9 (crypto_multi_accounts.rs, crypto_hd_key.rs,
 * crypto_key_path.rs, crypto_coin_info.rs): fingerprints are uint32 read big-endian, and a keypath
 * component is a flat `[index-or-empty-array, hardened-bool]` pair — the empty array is the
 * wildcard. Unknown map keys are skipped after their value parsed structurally, like the reference
 * decoder; a structural error anywhere is `integrity`.
 */
import { KernelError } from "../../../errors.ts";
import type { Cbor } from "./cbor.ts";

export const TAG_HD_KEY = 303;
export const TAG_KEY_PATH = 304;
export const TAG_COIN_INFO = 305;
export const TAG_MULTI_ACCOUNTS = 1103;

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
