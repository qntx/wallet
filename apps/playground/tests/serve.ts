/**
 * Serves the production build (`vp build` output) on 5417 — the path consumers ship, with no
 * dev-server dependency optimization. The emitted kernel.worker asset fetches its lazy payloads
 * (spark.wasm, code-split chunks, manifest) relative to its own URL in dist/assets/, so every
 * payload from @qntx/wallet-worker's dist is staged beside it.
 */
import { cpSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { preview } from "vite";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
const workerDir = join(require.resolve("@qntx/wallet-worker/package.json"), "..", "dist");
const payloads = readdirSync(workerDir).filter(
  (f) => f === "spark.wasm" || f === "kernel.manifest.json" || f.endsWith(".js"),
);
for (const file of payloads) {
  cpSync(join(workerDir, file), join(dist, "assets", file));
}

await preview({ root, preview: { port: 5417, strictPort: true } });
process.stdout.write("playground preview on :5417\n");
