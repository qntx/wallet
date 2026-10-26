/**
 * SparkExitChain persistence codec: JSON with Uint8Arrays tagged `{ $b64: "…" }` — small and
 * explicit rather than schema-bound, so upstream field additions survive a round-trip.
 */
import { base64 } from "@scure/base";

import type { SparkExitChain } from "@qntx/spark";

function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $b64: base64.encode(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)]));
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const b64: unknown =
      entries.length === 1 && entries[0]?.[0] === "$b64" ? entries[0][1] : undefined;
    if (typeof b64 === "string") {
      return base64.decode(b64);
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, decodeValue(v)]));
  }
  return value;
}

export function encodeExitChain(chain: SparkExitChain): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(encodeValue(chain)));
}

export function decodeExitChain(bytes: Uint8Array): SparkExitChain {
  const decoded: unknown = decodeValue(JSON.parse(new TextDecoder().decode(bytes)));
  // The codec round-trips what encodeExitChain wrote — the shape is structural.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return decoded as SparkExitChain;
}
