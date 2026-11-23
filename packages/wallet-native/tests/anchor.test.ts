import { describe, expect, it } from "vite-plus/test";

import { bindNativeAnchor } from "../kernel/anchor.ts";
import type { KernelAnchorNative } from "../kernel/anchor.ts";

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((value, index) => value === b[index]));

/** A faithful CAS anchor: `replace` swaps only when the stored bytes equal `expected`. */
const fakeAnchor = (initial?: Uint8Array): KernelAnchorNative => {
  let bytes: Uint8Array | undefined = initial;
  return {
    read: () => bytes,
    replace: (next, expected) => {
      if (!sameBytes(bytes, expected)) {
        return false;
      }
      bytes = next;
      return true;
    },
  };
};

describe("bindNativeAnchor", () => {
  it("delegates read and the compare-and-swap to the raw primitive", async () => {
    const anchor = bindNativeAnchor(fakeAnchor());
    await expect(anchor.read()).resolves.toBeUndefined();

    const record = new Uint8Array([1, 7, 9]);
    await expect(anchor.replace(record, undefined)).resolves.toBe(true);
    await expect(anchor.read()).resolves.toStrictEqual(record);

    await expect(anchor.replace(new Uint8Array([2]), new Uint8Array([9]))).resolves.toBe(false);
    await expect(anchor.read()).resolves.toStrictEqual(record);

    await expect(anchor.replace(new Uint8Array([5, 6]), record)).resolves.toBe(true);
    await expect(anchor.read()).resolves.toStrictEqual(new Uint8Array([5, 6]));

    await expect(anchor.replace(new Uint8Array(0), undefined)).resolves.toBe(false);
  });

  it("turns a synchronous platform throw into a rejection", async () => {
    const failing: KernelAnchorNative = {
      read: () => {
        throw new Error("keystore gone");
      },
      replace: () => {
        throw new Error("keystore gone");
      },
    };
    const anchor = bindNativeAnchor(failing);
    await expect(anchor.read()).rejects.toThrow("keystore gone");
    await expect(anchor.replace(new Uint8Array(1), undefined)).rejects.toThrow("keystore gone");
  });
});
