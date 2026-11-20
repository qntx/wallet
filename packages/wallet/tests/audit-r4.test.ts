/**
 * R4-W1: `BytesFieldOf` only classifies a field whose whole type is `Uint8Array` or
 * `ReadonlyArray<Uint8Array>`; byte-carrying fields spelled any other way escape
 * {@link UnclassifiedBytesField} entirely, so a new secret spelled like `a`/`b`/`c`/`e` would
 * silently count as public. This test asserts the gap — it passes at HEAD.
 */
import { describe, expectTypeOf, it } from "vite-plus/test";

import type { BytesFieldOf } from "../src/factors.ts";

describe("R4-W1 BytesFieldOf misses byte-carrying field shapes", () => {
  it("reports only the bare Uint8Array field", () => {
    // Unclassified byte holders that escape: `a` (bytes hidden in a union), `b` (nullable
    // elements inside the array), `c` (an ArrayBuffer — still raw bytes), `e` (bytes held as
    // map values — BytesFieldOf never walks into non-array/non-record containers).
    expectTypeOf<
      BytesFieldOf<{
        a: Uint8Array | string;
        b: ReadonlyArray<Uint8Array | null>;
        c: ArrayBuffer;
        d: Uint8Array;
        e: ReadonlyMap<string, Uint8Array>;
      }>
    >().toEqualTypeOf<"d">();
  });
});
