/**
 * The browser kernel worker entry, bundled to dist/kernel.worker.js by `bun build`: the kernel runs
 * on this worker's global scope and reads spark.wasm from next to the bundle.
 */
import { startBrowserKernel } from "./browser-kernel.ts";

startBrowserKernel(globalThis, new URL("spark.wasm", import.meta.url));
