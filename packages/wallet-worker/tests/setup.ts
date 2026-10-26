import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export default function setup(): void {
  const out = join(import.meta.dirname, "..", "dist", "spark.wasm");
  if (existsSync(out)) {
    return;
  }
  // vp caches `bun build` and `copy-spark-wasm` as separate sub-tasks: a cache miss on the
  // kernel build plus a hit on the copy leaves dist without spark.wasm.
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve("@qntx/spark-wasm/package.json"));
  copyFileSync(join(pkgDir, "dist", "spark.wasm"), out);
}
