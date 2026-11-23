import { SECRET_FIELDS } from "@qntx/wallet/protocol";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../errors.ts";

const SECRET_KEYS: ReadonlySet<string> = new Set<string>(SECRET_FIELDS);

type Leaf = {
  readonly buffer: ArrayBufferLike;
  readonly start: number;
  readonly end: number;
  readonly secret: boolean;
};

/**
 * A request's secret byte fields must own their memory: the kernel consumes and wipes each of them,
 * so a secret sharing memory with another field — the same object or an overlapping view of one
 * buffer, both preserved by structured clone — would zero that field between the prompt and the
 * sign pass. `respond` runs this before any decode: a leaf is secret when the nearest key that
 * holds it is in `SECRET_FIELDS` (array elements inherit the array's key). Within one buffer, a
 * secret leaf's byte range may not intersect any other leaf's; disjoint views and sharing between
 * public fields are allowed.
 */
export function assertExclusiveSecrets(params: ProtocolValue): void {
  // Walk by path without deduping: a container reached twice contributes its leaves twice —
  // a leaf that aliases itself still proves shared memory. The same expansion just ran under
  // `requestBytes`, so the walk is already bounded by MAX_REQUEST_BYTES.
  const groups = new Map<ArrayBufferLike, Leaf[]>();
  const stack: Array<{ readonly value: ProtocolValue; readonly key: string | undefined }> = [
    { value: params, key: undefined },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      continue;
    }
    const { value, key } = frame;
    if (value instanceof Uint8Array) {
      const leaf: Leaf = {
        buffer: value.buffer,
        start: value.byteOffset,
        end: value.byteOffset + value.byteLength,
        secret: key !== undefined && SECRET_KEYS.has(key),
      };
      const group = groups.get(leaf.buffer);
      if (group === undefined) {
        groups.set(leaf.buffer, [leaf]);
      } else {
        group.push(leaf);
      }
      continue;
    }
    if (Array.isArray(value)) {
      // Array.isArray widens the readonly member to any[] — re-annotate the element domain.
      const elements: ReadonlyArray<ProtocolValue> = value;
      for (const element of elements) {
        stack.push({ value: element, key });
      }
      continue;
    }
    if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        stack.push({ value: child, key: childKey });
      }
    }
  }
  for (const group of groups.values()) {
    if (!group.some((leaf) => leaf.secret)) {
      continue;
    }
    // Sweep left to right over the non-empty leaves, sorted by start: a leaf intersects an earlier
    // one exactly when its start lies below the farthest end seen — a secret may intersect nothing
    // (maxEndAll), a public leaf no secret (maxEndSecret). Empty ranges never intersect.
    let maxEndAll = 0;
    let maxEndSecret = 0;
    for (const leaf of [...group].sort((a, b) => a.start - b.start)) {
      if (leaf.end <= leaf.start) {
        continue;
      }
      if ((leaf.secret && leaf.start < maxEndAll) || (!leaf.secret && leaf.start < maxEndSecret)) {
        throw new KernelError("invalid-input", "a secret field shares memory with another field");
      }
      if (leaf.end > maxEndAll) {
        maxEndAll = leaf.end;
      }
      if (leaf.secret && leaf.end > maxEndSecret) {
        maxEndSecret = leaf.end;
      }
    }
  }
}
