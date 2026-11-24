/**
 * The Keystone-Connect pairing sync: decode the `crypto-multi-accounts` the device shows over QR
 * and pin exactly the public material the design names — the six BIP-32 account nodes and the two
 * SLIP-10 ed25519 leaves a Keystone 3 Pro publishes. Every other key (DOGE/XRP/LTC/BCH/ZEC/ADA
 * accounts, the ledger-legacy/live derivatives without chain code) parses structurally and is then
 * ignored: it may not influence the pin.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { cryptoMultiAccountsCodec } from "@qntx/ur/interop";
import type { Keypath } from "@qntx/ur/interop";
import type { KeyPath } from "@qntx/wallet-chains";
import type { DeviceResponse } from "@qntx/wallet/protocol";

import type { PinnedEd25519, PinnedNode } from "../../../derive/pinned.ts";
import { fingerprintBytes, samePath } from "../../../derive/pinned.ts";
import { KernelError } from "../../../errors.ts";
import type { PairingResult } from "../driver.ts";
import { decodeRegistry } from "./registry.ts";

const HARDENED = 0x80000000;

/** The BIP-32 account nodes the sync pins: btc purposes, ethereum and tron, coin 0' account 0'. */
const SECP256K1_PATHS: ReadonlyArray<KeyPath> = [
  [44 + HARDENED, HARDENED, HARDENED],
  [49 + HARDENED, HARDENED, HARDENED],
  [84 + HARDENED, HARDENED, HARDENED],
  [86 + HARDENED, HARDENED, HARDENED],
  [44 + HARDENED, 60 + HARDENED, HARDENED],
  [44 + HARDENED, 195 + HARDENED, HARDENED],
];

/** The solana account and its change leaf — the only ed25519 keys the sync pins. */
const ED25519_PATHS: ReadonlyArray<KeyPath> = [
  [44 + HARDENED, 501 + HARDENED, HARDENED],
  [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED],
];

function fail(): never {
  throw new KernelError("integrity", "malformed crypto-multi-accounts sync");
}

/** The derivation path a keypath claims, or `undefined` when a non-index makes it unpinnable. */
export const pathOf = (keyPath: Keypath): KeyPath | undefined => {
  const components: number[] = [];
  for (const component of keyPath.components) {
    if (component.kind !== "index" || component.index > 0x7fffffff) {
      return undefined;
    }
    components.push(component.index + (component.hardened ? HARDENED : 0));
  }
  return components;
};

/** A registry uint32 fingerprint as the four-byte big-endian form the kernel pins. */
/** Parses the QR response: exactly a `crypto-multi-accounts` UR or `integrity`. */
export const parseSync = (response: DeviceResponse): PairingResult => {
  if (response.kind !== "qr" || response.ur.type !== "crypto-multi-accounts") {
    fail();
  }
  const accounts = decodeRegistry(response.ur.cbor, cryptoMultiAccountsCodec);
  const nodes: PinnedNode[] = [];
  const ed25519: PinnedEd25519[] = [];
  const claimed: KeyPath[] = [];
  for (const entry of accounts.keys) {
    const { key } = entry;
    const path = key.origin === undefined ? undefined : pathOf(key.origin);
    // A key that cannot name its own path is not pinnable.
    const source = key.origin?.sourceFingerprint;
    if (source !== undefined && source !== accounts.masterFingerprint) {
      fail();
    }
    if (path === undefined) {
      continue;
    }
    // Two pinnable keys claiming one path cannot both be the device account for it.
    if (claimed.some((seen) => samePath(seen, path))) {
      fail();
    }
    claimed.push(path);
    if (SECP256K1_PATHS.some((wanted) => samePath(path, wanted))) {
      if (
        entry.curve !== "secp256k1" ||
        key.chainCode === undefined ||
        !secp256k1.utils.isValidPublicKey(key.keyData)
      ) {
        fail();
      }
      nodes.push({
        path,
        publicKey: new Uint8Array(key.keyData),
        chainCode: new Uint8Array(key.chainCode),
        ...(key.parentFingerprint === undefined
          ? {}
          : { parent: fingerprintBytes(key.parentFingerprint) }),
      });
    } else if (ED25519_PATHS.some((wanted) => samePath(path, wanted))) {
      if (entry.curve !== "ed25519") {
        fail();
      }
      ed25519.push({ path, publicKey: new Uint8Array(key.keyData) });
    }
  }
  if (nodes.length === 0 && ed25519.length === 0) {
    fail();
  }
  return {
    fingerprint: fingerprintBytes(accounts.masterFingerprint),
    ...(accounts.device === undefined ? {} : { model: accounts.device }),
    ...(accounts.version === undefined ? {} : { firmware: accounts.version }),
    nodes,
    ed25519,
  };
};
