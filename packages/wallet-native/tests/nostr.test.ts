import { describe, expect, it } from "vite-plus/test";

import { CryptoError } from "@qntx/nostr";

import { KernelError } from "../../wallet-kernel/src/errors.ts";
import { bindNativeNostr, NOSTR_NATIVE_ABI_VERSION } from "../kernel/nostr.ts";
import type { KernelNostrNative } from "../kernel/nostr.ts";

const OUT = new Uint8Array([1, 2, 3]);

function fakeRaw(overrides: Partial<KernelNostrNative> = {}): KernelNostrNative {
  return {
    abiVersion: NOSTR_NATIVE_ABI_VERSION,
    publicKey: () => OUT,
    sign: () => OUT,
    verifySerialized: () => true,
    ecdhX: () => OUT,
    ...overrides,
  };
}

describe("bindNativeNostr", () => {
  it("rejects an ABI mismatch as integrity, before any call", () => {
    const raw = fakeRaw({ abiVersion: NOSTR_NATIVE_ABI_VERSION + 1 });
    expect(() => bindNativeNostr(raw)).toThrow(
      expect.objectContaining({ code: "integrity" }) as Error,
    );
    expect(() => bindNativeNostr(raw)).toThrow(KernelError);
  });

  it("maps nostr_native: errors to CryptoError", () => {
    const backend = bindNativeNostr(
      fakeRaw({
        publicKey: () => {
          throw new Error("nostr_native: publicKey rejected the input");
        },
        ecdhX: () => {
          throw new Error("nostr_native: ecdhX rejected the input");
        },
      }),
    );
    expect(() => backend.publicKey(new Uint8Array(32))).toThrow(CryptoError);
    expect(() => backend.ecdhX(new Uint8Array(32), new Uint8Array(32))).toThrow(
      new CryptoError("nostr_native: ecdhX rejected the input"),
    );
  });

  it("passes verifySerialized through untouched", () => {
    const backend = bindNativeNostr(fakeRaw({ verifySerialized: () => false }));
    expect(
      backend.verifySerialized(
        new Uint8Array(1),
        new Uint8Array(32),
        new Uint8Array(32),
        new Uint8Array(64),
      ),
    ).toBe(false);
  });

  it("passes arguments through and returns the raw bytes", () => {
    let seen: { id?: Uint8Array; sk?: Uint8Array; aux?: Uint8Array } = {};
    const backend = bindNativeNostr(
      fakeRaw({
        sign: (id, sk, aux) => {
          seen = { id, sk, aux };
          return OUT;
        },
      }),
    );
    const id = new Uint8Array(32).fill(1);
    const sk = new Uint8Array(32).fill(2);
    const aux = new Uint8Array(32).fill(3);
    expect(backend.sign(id, sk, aux)).toStrictEqual(OUT);
    expect(seen).toStrictEqual({ id, sk, aux });
  });

  it("rethrows non-backend errors untouched", () => {
    const backend = bindNativeNostr(
      fakeRaw({
        sign: () => {
          throw new TypeError("plain failure");
        },
      }),
    );
    expect(() => backend.sign(new Uint8Array(32), new Uint8Array(32), new Uint8Array(32))).toThrow(
      TypeError,
    );
  });
});
