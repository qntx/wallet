/**
 * The spark backend loader shared by the browser and Node worker entries: the shipped spark.wasm
 * bytes are hashed and compared against SPARK_WASM_INTEGRITY before instantiation — a mismatch is
 * an `integrity` failure, never a load. Bytes always come from the entry's own read (fetch next to
 * the worker script, readFile next to kernel.node.js); the package's ambient fetch path is never
 * used.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";

import type { SparkCrypto } from "@qntx/spark/crypto";
import { KernelError } from "@qntx/wallet-kernel";

export async function loadSparkBackend(readWasm: () => Promise<Uint8Array>): Promise<SparkCrypto> {
  // Dynamic: spark-wasm stays out of the initial kernel bundle and loads with the first spark call.
  const { loadSparkWasm, SPARK_WASM_INTEGRITY } = await import("@qntx/spark-wasm/browser");
  const bytes = await readWasm();
  const integrity = `sha256-${base64.encode(sha256(bytes))}`;
  if (integrity !== SPARK_WASM_INTEGRITY) {
    throw new KernelError("integrity", "spark.wasm failed the integrity check");
  }
  return loadSparkWasm({ module: bytes });
}
