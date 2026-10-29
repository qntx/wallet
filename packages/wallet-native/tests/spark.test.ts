import { describe, expect, it } from "vite-plus/test";

import { SPARK_ABI_VERSION, SparkCryptoError } from "@qntx/spark/crypto";

import { KernelError } from "../../wallet-kernel/src/errors.ts";
import { bindNativeSpark } from "../kernel/spark.ts";
import type { KernelSparkNative } from "../kernel/spark.ts";

const OUT = new Uint8Array([1, 2, 3]);

function fakeRaw(overrides: Partial<KernelSparkNative> = {}): KernelSparkNative {
  return {
    abiVersion: SPARK_ABI_VERSION,
    frostCommit: () => OUT,
    frostSign: () => OUT,
    frostAggregate: () => OUT,
    eciesEncrypt: () => OUT,
    eciesDecrypt: () => OUT,
    splitSecretWithProofs: () => OUT,
    ...overrides,
  };
}

describe("bindNativeSpark", () => {
  it("rejects an ABI mismatch as integrity, before any call", () => {
    const raw = fakeRaw({ abiVersion: SPARK_ABI_VERSION + 1 });
    expect(() => bindNativeSpark(raw)).toThrow(
      expect.objectContaining({ code: "integrity" }) as Error,
    );
    expect(() => bindNativeSpark(raw)).toThrow(KernelError);
  });

  it("maps qntx_spark:<code> errors to SparkCryptoError on every method", () => {
    const crypto = bindNativeSpark(
      fakeRaw({
        frostCommit: () => {
          throw new Error("qntx_spark:2");
        },
        eciesDecrypt: () => {
          throw new Error("qntx_spark:7");
        },
      }),
    );
    expect(() => crypto.frostCommit(new Uint8Array(32), new Uint8Array(32))).toThrow(
      new SparkCryptoError(2),
    );
    expect(() => crypto.eciesDecrypt(new Uint8Array(32), new Uint8Array(99))).toThrow(
      new SparkCryptoError(7),
    );
  });

  it("passes arguments through and returns the raw bytes", () => {
    const secret = new Uint8Array(32).fill(7);
    const random = new Uint8Array(32).fill(9);
    let seen: { secret?: Uint8Array; threshold?: number; shares?: number; random?: Uint8Array } =
      {};
    const crypto = bindNativeSpark(
      fakeRaw({
        splitSecretWithProofs: (s, t, n, r) => {
          seen = { secret: s, threshold: t, shares: n, random: r };
          return OUT;
        },
      }),
    );
    const result = crypto.splitSecretWithProofs(secret, 2, 3, random);
    expect(result).toBe(OUT);
    expect(seen).toStrictEqual({ secret, threshold: 2, shares: 3, random });
    expect(crypto.abiVersion).toBe(SPARK_ABI_VERSION);
  });

  it("lets non-ABI errors pass through untouched", () => {
    const other = new TypeError("view exceeds its ArrayBuffer");
    const crypto = bindNativeSpark(
      fakeRaw({
        frostSign: () => {
          throw other;
        },
      }),
    );
    expect(() => crypto.frostSign(new Uint8Array(4))).toThrow(other);
    // A message merely containing the code shape but not the contract form is untouched.
    const notMapped = bindNativeSpark(
      fakeRaw({
        frostAggregate: () => {
          throw new Error("failure qntx_spark:5 trailing");
        },
      }),
    );
    expect(() => notMapped.frostAggregate(new Uint8Array(4))).toThrow(
      "failure qntx_spark:5 trailing",
    );
  });
});
