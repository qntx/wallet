import { hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import type { Versions } from "@scure/bip32";
/**
 * The `PublicMaterial` a card wallet answers from its cached record body — the seed stays on the
 * cards, so this never derives past a hardened index the tap did not cache. `[]` is the master; any
 * other secp256k1 path resolves through the longest cached prefix whose remaining indices are all
 * non-hardened (public derivation). Anything else is `card-required`: the caller taps a card.
 */
import { hash160 } from "@scure/btc-signer/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";

import type { PublicMaterial } from "../../derive/material.ts";
// oxlint-disable typescript/require-await -- every method satisfies the Promise-typed
// PublicMaterial contract; card material is all synchronous lookups and public derivation.
import { KernelError } from "../../errors.ts";
import { pathString } from "../chains/keys.ts";
import type { CardWalletBody } from "./record.ts";

const HARDENED = 0x80000000;

const cardRequired = (): KernelError =>
  new KernelError("card-required", "this key needs a card tap");

/** The cached or publicly derived node at `path`, or `undefined` when a card tap is needed. */
const nodeAt = (body: CardWalletBody, path: KeyPath): HDKey | undefined => {
  for (let depth = path.length; depth >= 1; depth -= 1) {
    const cached = body.nodes[pathString(path.slice(0, depth))];
    if (cached === undefined) {
      continue;
    }
    const remainder = path.slice(depth);
    if (remainder.some((index) => index >= HARDENED)) {
      // A hardened step below a cached node still needs the card; shorter prefixes can only
      // leave a longer remainder, so nothing further can resolve this path.
      return undefined;
    }
    let node = new HDKey({
      publicKey: hexToBytes(cached.key),
      chainCode: hexToBytes(cached.chainCode),
    });
    for (const index of remainder) {
      node = node.deriveChild(index);
    }
    return node;
  }
  return undefined;
};

export function cardMaterial(body: CardWalletBody): PublicMaterial {
  const master = hexToBytes(body.master);
  return {
    secp256k1: async (path) => {
      if (path.length === 0) {
        return master;
      }
      const node = nodeAt(body, path);
      if (node === undefined || node.publicKey === null) {
        throw cardRequired();
      }
      return node.publicKey;
    },
    ed25519: async (path) => {
      const cached = body.ed25519[pathString(path)];
      if (cached === undefined) {
        throw cardRequired();
      }
      return hexToBytes(cached);
    },
    extendedPublicKey: async (path, versions: Versions) => {
      const node = nodeAt(body, path);
      if (node === undefined || node.publicKey === null || node.chainCode === null) {
        throw cardRequired();
      }
      // The parent's public key — `[]` is the stored master, anything else resolves like above.
      const parentPublic = path.length === 1 ? master : nodeAt(body, path.slice(0, -1))?.publicKey;
      if (parentPublic === undefined || parentPublic === null) {
        throw cardRequired();
      }
      const view = new DataView(hash160(parentPublic).buffer, 0, 4);
      return new HDKey({
        versions,
        depth: path.length,
        index: path.at(-1) ?? 0,
        parentFingerprint: view.getUint32(0),
        chainCode: node.chainCode,
        publicKey: node.publicKey,
      }).publicExtendedKey;
    },
  };
}
