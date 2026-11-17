/**
 * The Node kernel worker entry, bundled to dist/kernel.node.js by `bun build`: the kernel runs on
 * this worker's parent port and reads spark.wasm from next to the bundle.
 */
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

import { startNodeKernel } from "./node-kernel.ts";

startNodeKernel(
  parentPort ?? undefined,
  workerData,
  async () => new Uint8Array(await readFile(new URL("spark.wasm", import.meta.url))),
);
