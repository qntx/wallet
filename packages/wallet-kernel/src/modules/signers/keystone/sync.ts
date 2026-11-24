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

import { KernelError } from "../../../errors.ts";
import type { PinnedEd25519, PinnedNode } from "../../../derive/pinned.ts";
import { fingerprintBytes, samePath } from "../../../derive/pinned.ts";
import type { PairingResult } from "../driver.ts";
import { decodeUr } from "./ur.ts";

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

/**
 * The derivation path a keypath claims, or `undefined` when a non-index component (wildcard, range,
 * pair) makes it unpinnable.
 */
export const pathOf = (keypath: Keypath): KeyPath | undefined => {
  const components: number[] = [];
  for (const component of keypath.components) {
    if (component.kind !== "index" || component.index > 0x7fffffff) {
      return undefined;
    }
    components.push(component.index + (component.hardened ? HARDENED : 0));
  }
  return components;
};

/** Parses the QR response: exactly a `crypto-multi-accounts` UR or `integrity`. */
export const parseSync = (response: DeviceResponse): PairingResult => {
  if (response.kind !== "qr" || response.ur.type !== "crypto-multi-accounts") {
    fail();
  }
  const accounts = decodeUr("crypto-multi-accounts", response.ur.cbor, cryptoMultiAccountsCodec);
  const nodes: PinnedNode[] = [];
  const ed25519: PinnedEd25519[] = [];
  const claimed: KeyPath[] = [];
  for (const key of accounts.keys) {
    const { origin } = key.key;
    const path = origin === undefined ? undefined : pathOf(origin);
    if (
      origin?.sourceFingerprint !== undefined &&
      origin.sourceFingerprint !== accounts.masterFingerprint
    ) {
      fail();
    }
    // A key that cannot name its own path is not pinnable.
    if (path === undefined) {
      continue;
    }
    // Two pinnable keys claiming one path cannot both be the device account for it.
    if (claimed.some((seen) => samePath(seen, path))) {
      fail();
    }
    claimed.push(path);
    if (SECP256K1_PATHS.some((wanted) => samePath(path, wanted))) {
      if (key.curve !== "secp256k1") {
        fail();
      }
      const node = key.key;
      if (
        node.chainCode === undefined ||
        node.chainCode.length !== 32 ||
        !secp256k1.utils.isValidPublicKey(node.keyData)
      ) {
        fail();
      }
      nodes.push({
        path,
        publicKey: new Uint8Array(node.keyData),
        chainCode: new Uint8Array(node.chainCode),
        ...(node.parentFingerprint === undefined
          ? {}
          : { parent: fingerprintBytes(node.parentFingerprint) }),
      });
    } else if (ED25519_PATHS.some((wanted) => samePath(path, wanted))) {
      if (key.curve !== "ed25519") {
        fail();
      }
      ed25519.push({ path, publicKey: new Uint8Array(key.key.keyData) });
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
