/**
 * Kernel entry: the script compiled to bytecode and embedded in the runtime. Builds the platform
 * from the injected `__qntx` object and starts the kernel on the frame transport. `backends.spark`
 * rejects until W4 (native Spark backend); `backends.nostr` is noble.
 */
import { nobleBackend } from "@qntx/nostr";

import { startKernel } from "../../wallet-kernel/src/kernel.ts";
import type { KernelPlatform } from "../../wallet-kernel/src/platform.ts";
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
  readonly file: KernelFile;
  readonly frames: KernelFramePipe;
};

declare const __qntx: KernelGlobals;

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
  store: createFileStore(__qntx.file),
  // No foreground idle lock on native — the host locks on backgrounding after
  // autoLock.backgroundSeconds (W7); the session still ends at 24 h.
  policy: { maxSessionMs: 24 * 3_600_000, maxScryptLogN: 18 },
  backends: {
    nostr: nobleBackend,
    // W4 brings the native spark backend; until then spark.* answers `unavailable`.
    // oxlint-disable-next-line typescript/promise-function-async -- a pure rejection needs no async body
    spark: () => Promise.reject(new Error("spark backend not available on this host")),
  },
};

startKernel(platform, createKernelPort(__qntx.frames));
