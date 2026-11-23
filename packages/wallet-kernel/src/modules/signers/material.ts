/**
 * Pinned public material — the `PublicMaterial` a hardware-wallet record serves without any secret.
 * secp256k1 paths resolve to an exact pinned node or by public derivation under the nearest pinned
 * ancestor when every remaining segment is non-hardened; ed25519 paths only ever resolve exactly
 * (SLIP-10 has no public derivation). Anything else — including the master key `[]` — is
 * `device-required`: only the device itself can answer it.
 */
// oxlint-disable typescript/require-await -- every method satisfies the Promise-typed contract; the
// pinned material resolves synchronously.
import { HDKey } from "@scure/bip32";
import type { Versions } from "@scure/bip32";

import type { KeyPath } from "@qntx/wallet-chains";

import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import type { HardwarePin, PinnedNode } from "./driver.ts";

const HARDENED = 0x80000000;

const deviceRequired = (): KernelError =>
  new KernelError("device-required", "the device must derive this path");

const samePath = (a: KeyPath, b: KeyPath): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const nodeAt = (pin: HardwarePin, path: KeyPath): PinnedNode | undefined =>
  pin.nodes.find((node) => samePath(node.path, path));

/**
 * The deepest pinned ancestor whose remaining tail is fully non-hardened — the only situation in
 * which BIP-32 public derivation reaches `path`. `[]` is never derivable.
 */
const derivingAncestor = (pin: HardwarePin, path: KeyPath): PinnedNode | undefined =>
  pin.nodes
    .filter(
      (node) =>
        node.path.length < path.length &&
        path.slice(0, node.path.length).every((v, i) => v === node.path[i]) &&
        path.slice(node.path.length).every((v) => v < HARDENED),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];

const derivePublic = (node: PinnedNode, path: KeyPath): Uint8Array => {
  const root = new HDKey({ publicKey: node.publicKey, chainCode: node.chainCode });
  const tail = path.slice(node.path.length);
  const child = tail.length === 0 ? root : root.derive(`m/${tail.join("/")}`);
  if (child.publicKey === null) {
    throw deviceRequired();
  }
  return child.publicKey;
};

const fingerprintNumber = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);

/** The record's pinned material as a `PublicMaterial`; the fingerprint is the pinned claim. */
export const pinnedMaterial = (pin: HardwarePin): PublicMaterial => ({
  secp256k1: async (path) => {
    if (path.length === 0) {
      throw deviceRequired();
    }
    const node = nodeAt(pin, path);
    if (node !== undefined) {
      return node.publicKey;
    }
    const ancestor = derivingAncestor(pin, path);
    if (ancestor === undefined) {
      throw deviceRequired();
    }
    return derivePublic(ancestor, path);
  },
  ed25519: async (path) => {
    const key = pin.ed25519.find((k) => samePath(k.path, path));
    if (key === undefined) {
      throw deviceRequired();
    }
    return key.publicKey;
  },
  extendedPublicKey: async (path, versions: Versions) => {
    const node = nodeAt(pin, path);
    if (node === undefined || path.length === 0 || node.parent === undefined) {
      throw deviceRequired();
    }
    return new HDKey({
      versions,
      depth: path.length,
      index: path.at(-1) ?? 0,
      parentFingerprint: fingerprintNumber(node.parent),
      chainCode: node.chainCode,
      publicKey: node.publicKey,
    }).publicExtendedKey;
  },
  fingerprint: async () => pin.fingerprint,
});
