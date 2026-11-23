/**
 * The Keystone-Connect pairing sync: decode the `crypto-multi-accounts` the device shows over QR
 * and pin exactly the public material the design names — the six BIP-32 account nodes and the two
 * SLIP-10 ed25519 leaves a Keystone 3 Pro publishes. Every other key (DOGE/XRP/LTC/BCH/ZEC/ADA
 * accounts, the ledger-legacy/live derivatives without chain code) parses structurally and is then
 * ignored: it may not influence the pin.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { KeyPath } from "@qntx/wallet-chains";
import type { DeviceResponse } from "@qntx/wallet/protocol";

import type { PinnedEd25519, PinnedNode } from "../../../derive/pinned.ts";
import { KernelError } from "../../../errors.ts";
import type { PairingResult } from "../driver.ts";
import { decodeCbor } from "./cbor.ts";
import { multiAccounts } from "./registry.ts";
import type { CryptoKeyPath } from "./registry.ts";

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

/** The derivation path a keypath claims, or `undefined` when a wildcard makes it unpinnable. */
export const pathOf = (keyPath: CryptoKeyPath): KeyPath | undefined => {
  const components: number[] = [];
  for (const component of keyPath.components) {
    if (component.index === undefined || component.index > 0x7fffffff) {
      return undefined;
    }
    components.push(component.index + (component.hardened ? HARDENED : 0));
  }
  return components;
};

export const samePath = (a: KeyPath, b: KeyPath): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Parses the QR response: exactly a `crypto-multi-accounts` UR or `integrity`. */
export const parseSync = (response: DeviceResponse): PairingResult => {
  if (response.kind !== "qr" || response.ur.type !== "crypto-multi-accounts") {
    fail();
  }
  const accounts = multiAccounts(decodeCbor(response.ur.cbor));
  const nodes: PinnedNode[] = [];
  const ed25519: PinnedEd25519[] = [];
  const claimed: KeyPath[] = [];
  for (const key of accounts.keys) {
    const path = key.origin === undefined ? undefined : pathOf(key.origin);
    // A key that cannot name its own path — or one carrying secret material — is not pinnable.
    if (key.origin !== undefined) {
      const source = key.origin.sourceFingerprint;
      if (source !== undefined && !equalBytes(source, accounts.masterFingerprint)) {
        fail();
      }
    }
    if (key.isMaster || key.isPrivate || key.key === undefined || path === undefined) {
      continue;
    }
    // Two pinnable keys claiming one path cannot both be the device account for it.
    if (claimed.some((seen) => samePath(seen, path))) {
      fail();
    }
    claimed.push(path);
    if (SECP256K1_PATHS.some((wanted) => samePath(path, wanted))) {
      if (
        key.key.length !== 33 ||
        key.chainCode === undefined ||
        key.chainCode.length !== 32 ||
        !secp256k1.utils.isValidPublicKey(key.key)
      ) {
        fail();
      }
      nodes.push({
        path,
        publicKey: new Uint8Array(key.key),
        chainCode: new Uint8Array(key.chainCode),
        ...(key.parentFingerprint === undefined
          ? {}
          : { parent: new Uint8Array(key.parentFingerprint) }),
      });
    } else if (ED25519_PATHS.some((wanted) => samePath(path, wanted))) {
      if (key.key.length !== 32) {
        fail();
      }
      ed25519.push({ path, publicKey: new Uint8Array(key.key) });
    }
  }
  if (nodes.length === 0 && ed25519.length === 0) {
    fail();
  }
  return {
    fingerprint: accounts.masterFingerprint,
    ...(accounts.device === undefined ? {} : { model: accounts.device }),
    ...(accounts.deviceVersion === undefined ? {} : { firmware: accounts.deviceVersion }),
    nodes,
    ed25519,
  };
};
