/**
 * The browser kernel: every platform capability the Web enclave needs, wired onto one message
 * endpoint — subtle PBKDF2, the IndexedDB vault store, timers through platform.setTimer, and the
 * session policy from the host's init message. The kernel does not start until a strictly validated
 * init arrives. `kernel.worker.js` runs this on the worker's global scope.
 */
import { nobleBackend } from "@qntx/nostr";
import { startKernel } from "@qntx/wallet-kernel";
import type { KernelPlatform, Port } from "@qntx/wallet-kernel";

import { MAX_SESSION_MS, idleMsOf, isBrowserWorkerInit } from "../shared.ts";
import { createIndexedDbStore } from "./indexeddb.ts";
import { basePlatform } from "./platform.ts";
import { loadSparkBackend } from "./spark.ts";

/** Where the kernel talks to its host: a dedicated worker's global scope, or a MessagePort. */
export type KernelScope = {
  readonly postMessage: (message: unknown, transfer: Transferable[]) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
};

export function startBrowserKernel(scope: KernelScope, sparkWasm: URL): void {
  const onInit = (event: MessageEvent<unknown>): void => {
    const { data } = event;
    if (!isBrowserWorkerInit(data)) {
      return; // not the init message — the kernel must not start without a valid policy
    }
    scope.removeEventListener("message", onInit);

    const platform: KernelPlatform = {
      ...basePlatform(),
      store: createIndexedDbStore(),
      // Session limits are owned here, not by the page: idle from the validated init message,
      // the fixed maximum, and the scrypt ceiling for this platform. Only presence-bearing
      // methods refresh the idle timer — request traffic does not keep a session alive.
      policy: {
        idle: { ms: idleMsOf(data.idleMinutes), activity: "presence" },
        maxSessionMs: MAX_SESSION_MS,
        maxScryptLogN: 18,
      },
      backends: {
        nostr: nobleBackend,
        spark: async () =>
          loadSparkBackend(async () => {
            const response = await fetch(sparkWasm);
            if (!response.ok) {
              throw new Error(`spark.wasm fetch failed (HTTP ${response.status})`);
            }
            return new Uint8Array(await response.arrayBuffer());
          }),
      },
    };

    const port: Port = {
      post: (message, transfer) => {
        scope.postMessage(message, transfer);
      },
      listen: (handler) => {
        const listener = (messageEvent: MessageEvent<unknown>): void => {
          handler(messageEvent.data);
        };
        scope.addEventListener("message", listener);
        return () => {
          scope.removeEventListener("message", listener);
        };
      },
    };

    startKernel(platform, port);
  };

  scope.addEventListener("message", onInit);
}
