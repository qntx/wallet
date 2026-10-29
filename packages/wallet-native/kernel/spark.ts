/**
 * Binds the native `__qntx.backends.spark` object to the `SparkCrypto` contract. The ABI version is
 * pinned: a mismatch means the linked libqntx_spark predates or postdates this kernel — an
 * `integrity` failure, never a load. `qntx_spark:<code>` errors from the C++ side map back to
 * `SparkCryptoError`; every other error passes through.
 *
 * The Nitro `bind.ts` in @qntx/spark-native is deliberately not reused: it copies inputs into
 * ArrayBuffers for Nitro's signature, and its package entry imports Nitro — neither belongs in the
 * kernel bundle.
 */
import { SPARK_ABI_VERSION, SparkCryptoError } from "@qntx/spark/crypto";
import type { SparkCrypto } from "@qntx/spark/crypto";

import { KernelError } from "../../wallet-kernel/src/errors.ts";

/** The `__qntx.backends.spark` surface the native host injects. */
export type KernelSparkNative = {
  readonly abiVersion: number;
  readonly frostCommit: (hedge: Uint8Array, random: Uint8Array) => Uint8Array;
  readonly frostSign: (request: Uint8Array) => Uint8Array;
  readonly frostAggregate: (request: Uint8Array) => Uint8Array;
  readonly eciesEncrypt: (
    publicKey: Uint8Array,
    plaintext: Uint8Array,
    random: Uint8Array,
  ) => Uint8Array;
  readonly eciesDecrypt: (privateKey: Uint8Array, ciphertext: Uint8Array) => Uint8Array;
  readonly splitSecretWithProofs: (
    secret: Uint8Array,
    threshold: number,
    shares: number,
    random: Uint8Array,
  ) => Uint8Array;
};

function call<T>(invoke: () => T): T {
  try {
    return invoke();
  } catch (error) {
    if (error instanceof Error) {
      const code = /^qntx_spark:(\d+)$/.exec(error.message)?.[1];
      if (code !== undefined) {
        throw new SparkCryptoError(Number(code));
      }
    }
    throw error;
  }
}

export function bindNativeSpark(raw: KernelSparkNative): SparkCrypto {
  if (raw.abiVersion !== SPARK_ABI_VERSION) {
    throw new KernelError(
      "integrity",
      `spark-native ABI version ${raw.abiVersion} does not match SPARK_ABI_VERSION ${SPARK_ABI_VERSION}`,
    );
  }
  return {
    abiVersion: raw.abiVersion,
    frostCommit: (hedge, random) => call(() => raw.frostCommit(hedge, random)),
    frostSign: (request) => call(() => raw.frostSign(request)),
    frostAggregate: (request) => call(() => raw.frostAggregate(request)),
    eciesEncrypt: (publicKey, plaintext, random) =>
      call(() => raw.eciesEncrypt(publicKey, plaintext, random)),
    eciesDecrypt: (privateKey, ciphertext) => call(() => raw.eciesDecrypt(privateKey, ciphertext)),
    splitSecretWithProofs: (secret, threshold, shares, random) =>
      call(() => raw.splitSecretWithProofs(secret, threshold, shares, random)),
  };
}
