import { base64 } from "@scure/base";

import { PHISHING_HASH_BYTES } from "./risk.ts";

/** Strictly ascending 8-byte hashes, concatenated: a sorted set. */
export type HashList = Uint8Array;

const WIDTH = PHISHING_HASH_BYTES;

function compareAt(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
  for (let k = 0; k < WIDTH; k += 1) {
    const delta = (a[ai * WIDTH + k] ?? 0) - (b[bi * WIDTH + k] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

const size = (list: HashList): number => list.length / WIDTH;

export const hashCount = size;

const isStrictlyAscending = (list: HashList): boolean => {
  for (let i = 1; i < size(list); i += 1) {
    if (compareAt(list, i - 1, list, i) >= 0) {
      return false;
    }
  }
  return true;
};

/**
 * A base64 hash list, or `undefined` when it is not whole 8-byte hashes in strictly ascending
 * order.
 */
export function decodeHashList(encoded: string): HashList | undefined {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(encoded);
  } catch {
    return undefined;
  }
  return bytes.length % WIDTH === 0 && isStrictlyAscending(bytes) ? bytes : undefined;
}

/** The sorted set of `hashes`, duplicates removed. */
export function hashList(hashes: Iterable<Uint8Array>): HashList {
  const sorted = [...hashes].sort((a, b) => compareAt(a, 0, b, 0));
  const out = new Uint8Array(sorted.length * WIDTH);
  let written = 0;
  let previous: Uint8Array | undefined;
  for (const hash of sorted) {
    if (previous === undefined || compareAt(previous, 0, hash, 0) !== 0) {
      out.set(hash, written);
      written += WIDTH;
      previous = hash;
    }
  }
  return out.slice(0, written);
}

export const encodeHashList = (list: HashList): string => base64.encode(list);

export function contains(list: HashList, hash: Uint8Array): boolean {
  let low = 0;
  let high = size(list) - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const order = compareAt(list, middle, hash, 0);
    if (order === 0) {
      return true;
    }
    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return false;
}

function merge(a: HashList, b: HashList, keep: (inA: boolean, inB: boolean) => boolean): HashList {
  const out = new Uint8Array(a.length + b.length);
  let written = 0;
  const take = (source: Uint8Array, index: number): void => {
    out.set(source.subarray(index * WIDTH, (index + 1) * WIDTH), written);
    written += WIDTH;
  };
  let i = 0;
  let j = 0;
  while (i < size(a) || j < size(b)) {
    const order = i >= size(a) ? 1 : j >= size(b) ? -1 : compareAt(a, i, b, j);
    if (order < 0) {
      if (keep(true, false)) {
        take(a, i);
      }
      i += 1;
    } else if (order > 0) {
      if (keep(false, true)) {
        take(b, j);
      }
      j += 1;
    } else {
      if (keep(true, true)) {
        take(a, i);
      }
      i += 1;
      j += 1;
    }
  }
  return out.slice(0, written);
}

export const union = (a: HashList, b: HashList): HashList => merge(a, b, () => true);

/** The hashes of `a` that are not in `b`. */
export const difference = (a: HashList, b: HashList): HashList =>
  merge(a, b, (inA, inB) => inA && !inB);

/** `(list − remove) ∪ add`. */
export const applyDiff = (list: HashList, add: HashList, remove: HashList): HashList =>
  union(difference(list, remove), add);
