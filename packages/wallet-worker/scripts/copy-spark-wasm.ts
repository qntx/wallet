/// <reference types="node" />
/**
 * Copies `@qntx/spark-wasm`'s shipped spark.wasm into dist/ next to kernel.worker.js and
 * kernel.node.js — both worker entries read it from beside their own script at runtime.
 *
 * Run from the package root: bun scripts/copy-spark-wasm.ts
 */
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = join(require.resolve("@qntx/spark-wasm/package.json"), "..");
const out = join(import.meta.dirname, "..", "dist", "spark.wasm");
copyFileSync(join(pkgDir, "dist", "spark.wasm"), out);
console.log(`wrote ${out}`);
