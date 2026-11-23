/**
 * Kernel entry: the script compiled to bytecode and embedded in the runtime. Builds the platform
 * from the injected `__qntx` object and starts the kernel on the frame transport. `backends.nostr`
 * and `backends.spark` binds the host's native qs_* bridge (ABI pinned by SPARK_ABI_VERSION).
 */

import { startKernel } from "../../wallet-kernel/src/kernel.ts";
import { PRODUCTION_ANCHORS } from "../../wallet-kernel/src/modules/card/protocol/index.ts";
import type { KernelPlatform } from "../../wallet-kernel/src/platform.ts";
import { bindNativeCardReader, bindNativeSecureInput } from "./card.ts";
import type { KernelCardReaderNative, KernelSecureInputNative } from "./card.ts";
import { bindNativeKeystore } from "./keystore.ts";
import type { KernelKeystoreNative } from "./keystore.ts";
import { bindNativeNostr } from "./nostr.ts";
import type { KernelNostrNative } from "./nostr.ts";
import { bindNativePasskey } from "./passkey.ts";
import type { KernelPasskeyNative } from "./passkey.ts";
import { bindNativeSpark } from "./spark.ts";
import type { KernelSparkNative } from "./spark.ts";
import { createFileStore } from "./store.ts";
import type { KernelFile } from "./store.ts";
import { createKernelPort } from "./transport.ts";
import type { KernelFramePipe } from "./transport.ts";

export type KernelGlobals = {
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly elapsed: () => number;
  readonly setTimer: (delayMs: number, fn: () => void) => () => void;
  readonly pbkdf2: (
    hash: "sha256" | "sha512",
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    length: number,
    callback: (result: Uint8Array | undefined, error: string | undefined) => void,
  ) => void;
  readonly argon2id: (
    password: Uint8Array,
    salt: Uint8Array,
    memoryKiB: number,
    passes: number,
    lanes: number,
    length: number,
    callback: (result: Uint8Array | undefined, error: string | undefined) => void,
  ) => void;
  readonly file: KernelFile;
  readonly keystore: KernelKeystoreNative;
  readonly passkey: KernelPasskeyNative;
  readonly cardReader: KernelCardReaderNative;
  readonly secureInput: KernelSecureInputNative;
  readonly frames: KernelFramePipe;
  readonly backends: {
    readonly spark: KernelSparkNative;
    readonly nostr: KernelNostrNative;
  };
};

declare const __qntx: KernelGlobals;

// Bound at kernel start so an ABI mismatch between the embedded entry and the host's native
// qs_* bridge refuses startup before the kernel serves a single frame — bindNativeSpark checks
// the version and only wraps the calls.
const spark = bindNativeSpark(__qntx.backends.spark);

const platform: KernelPlatform = {
  random: (length) => __qntx.random(length),
  now: () => __qntx.now(),
  elapsed: () => __qntx.elapsed(),
  setTimer: (delayMs, fn) => __qntx.setTimer(delayMs, fn),
  pbkdf2: async (hash, password, salt, iterations, length) =>
    new Promise((resolve, reject) => {
      __qntx.pbkdf2(hash, password, salt, iterations, length, (result, error) => {
        if (result === undefined) {
          reject(new Error(error ?? "pbkdf2 failed"));
          return;
        }
        resolve(result);
      });
    }),
  argon2id: async (password, salt, cost, length) =>
    new Promise((resolve, reject) => {
      __qntx.argon2id(
        password,
        salt,
        cost.memoryKiB,
        cost.passes,
        cost.lanes,
        length,
        (result, error) => {
          if (result === undefined) {
            reject(new Error(error ?? "argon2id failed"));
            return;
          }
          resolve(result);
        },
      );
    }),
  store: createFileStore(__qntx.file),
  keystore: bindNativeKeystore(__qntx.keystore),
  passkey: bindNativePasskey(__qntx.passkey, (length) => __qntx.random(length)),
  card: {
    reader: bindNativeCardReader(__qntx.cardReader),
    secureInput: bindNativeSecureInput(__qntx.secureInput),
    anchors: PRODUCTION_ANCHORS,
  },
  // No foreground idle lock on native — the host locks on backgrounding after
  // autoLock.backgroundSeconds (W7); the session still ends at 24 h.
  policy: { maxSessionMs: 24 * 3_600_000, maxScryptLogN: 18 },
  backends: {
    nostr: bindNativeNostr(__qntx.backends.nostr),
    // oxlint-disable-next-line typescript/require-await -- the loader signature is a promise
    spark: async () => spark,
  },
};

startKernel(platform, createKernelPort(__qntx.frames));
