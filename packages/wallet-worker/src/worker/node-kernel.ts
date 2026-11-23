/**
 * The Node kernel: every platform capability wired onto the worker's parent port — subtle PBKDF2,
 * the store RPC over the transferred MessagePort, timers through platform.setTimer, policy from
 * workerData. `kernel.node.js` runs this inside a worker_threads Worker.
 */
import type { MessagePort } from "node:worker_threads";

import { nobleBackend } from "@qntx/nostr";
import { startKernel } from "@qntx/wallet-kernel";
import type { KernelPlatform, Port } from "@qntx/wallet-kernel";

import { MAX_SESSION_MS, idleMsOf, isNodeWorkerData } from "../shared.ts";
import { basePlatform } from "./platform.ts";
import { loadSparkBackend } from "./spark.ts";
import { createStoreClient } from "./store-client.ts";

export type NodeWorkerData = {
  readonly idleMinutes: 5 | 15 | 60;
  readonly storePort: MessagePort;
};

export function startNodeKernel(
  main: MessagePort | undefined,
  workerData: unknown,
  readSparkWasm: () => Promise<Uint8Array>,
): void {
  if (main === undefined) {
    throw new Error("kernel.node.js must run inside a worker_threads Worker");
  }
  if (!isNodeWorkerData(workerData)) {
    throw new Error("kernel.node.js received invalid workerData");
  }
  const data: NodeWorkerData = {
    idleMinutes: workerData.idleMinutes,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isNodeWorkerData narrowed the shape; MessagePort is the node type
    storePort: workerData.storePort as MessagePort,
  };

  data.storePort.start();

  // The vault image and its anchor both live in the main thread: destroying this worker on lock
  // loses neither the ciphertext nor the rollback floor and failure counters.
  const { store, anchor } = createStoreClient({
    post: (message) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads port, not window.postMessage
      data.storePort.postMessage(message);
    },
    listen: (handler) => {
      const listener = (message: unknown) => {
        handler(message);
      };
      data.storePort.on("message", listener);
      return () => {
        data.storePort.off("message", listener);
      };
    },
  });

  const platform: KernelPlatform = {
    ...basePlatform(),
    store,
    anchor,
    // Session limits are owned here, not by the host: idle from the validated workerData, the
    // fixed maximum, and the scrypt ceiling for this platform. There is no human presence on
    // Node: every successful request refreshes the idle timer.
    policy: {
      idle: { ms: idleMsOf(data.idleMinutes), activity: "request" },
      maxSessionMs: MAX_SESSION_MS,
      maxScryptLogN: 20,
    },
    backends: {
      nostr: nobleBackend,
      spark: async () => loadSparkBackend(readSparkWasm),
    },
  };

  const port: Port = {
    post: (message, transfer) => {
      main.postMessage(message, transfer);
    },
    listen: (handler) => {
      const listener = (message: unknown) => {
        handler(message);
      };
      main.on("message", listener);
      return () => {
        main.off("message", listener);
      };
    },
  };

  startKernel(platform, port);
}
