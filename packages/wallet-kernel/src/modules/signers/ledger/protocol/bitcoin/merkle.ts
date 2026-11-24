/**
 * Merkle trees over pre-hashed leaves (doc/merkle.md "Data structures" — the RFC 6962 MTH with the
 * empty list redefined to 32 zero bytes; the reference implementation is
 * bitcoin_client_js/src/lib/merkle.ts, hashLeaf/calculateRoot/proveNode). Callers pass leaf hashes,
 * not leaf data: the root of a single leaf is that leaf hash unchanged, and internal nodes are
 * `sha256(0x01 ‖ left ‖ right)` over a split at the largest power of two strictly below n.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import { input } from "../bytes.ts";

/** `sha256(0x00 ‖ data)` — the domain-separated leaf hash of doc/merkle.md. */
export function leafHash(data: Uint8Array): Uint8Array {
  const h = new Uint8Array(1 + data.length);
  h.set(data, 1);
  return sha256(h);
}

const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const h = new Uint8Array(1 + 32 + 32);
  h[0] = 0x01;
  h.set(left, 1);
  h.set(right, 33);
  return sha256(h);
};

const checkLeaves = (leafHashes: ReadonlyArray<Uint8Array>): void => {
  for (const leaf of leafHashes) {
    if (leaf.length !== 32) {
      throw input("a Merkle leaf hash is not 32 bytes");
    }
  }
};

/** The largest power of two strictly below n (merkle.ts highestPowerOf2LessThan); requires n ≥ 2. */
const largestSplit = (n: number): number => {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
};

/** The MTH of a list of leaf hashes — empty → 32 zero bytes, single → the leaf itself. */
export function merkleRoot(leafHashes: ReadonlyArray<Uint8Array>): Uint8Array {
  checkLeaves(leafHashes);
  const [first] = leafHashes;
  if (first === undefined) {
    return new Uint8Array(32);
  }
  if (leafHashes.length === 1) {
    return Uint8Array.from(first);
  }
  const k = largestSplit(leafHashes.length);
  return nodeHash(merkleRoot(leafHashes.slice(0, k)), merkleRoot(leafHashes.slice(k)));
}

/**
 * The audit path for leaf `index`: sibling hashes bottom-up (merkle.ts proveNode — the sibling at
 * the leaf's own level first, then each ancestor's sibling up to below the root).
 */
export function merkleProof(
  leafHashes: ReadonlyArray<Uint8Array>,
  index: number,
): ReadonlyArray<Uint8Array> {
  checkLeaves(leafHashes);
  if (!Number.isSafeInteger(index) || index < 0 || index >= leafHashes.length) {
    throw input("Merkle proof index is out of range");
  }
  const walk = (leaves: ReadonlyArray<Uint8Array>, i: number): Uint8Array[] => {
    if (leaves.length === 1) {
      return [];
    }
    const k = largestSplit(leaves.length);
    return i < k
      ? [...walk(leaves.slice(0, k), i), merkleRoot(leaves.slice(k))]
      : [...walk(leaves.slice(k), i - k), merkleRoot(leaves.slice(0, k))];
  };
  return walk(leafHashes, index);
}
