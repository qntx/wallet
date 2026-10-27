/**
 * Serves the static test page. Dev mode (`bun ./serve.ts`) uses vite-plus's dev server on 4174 (the
 * brief's `optimizeDeps.exclude` only exists on the dev server). Build mode (`bun ./serve.ts
 * build`) runs `vite build` on the same page root into a temp dir and serves it with `vite preview`
 * on 4175 — the production path consumers ship: the page imports `@qntx/wallet-worker/browser` from
 * the built dist, and `new URL("kernel.worker.js", import.meta.url)` must resolve against the
 * emitted bundle.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build, createServer, preview } from "vite";

const require = createRequire(import.meta.url);

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
const root = new URL("page", import.meta.url).pathname;
const distDir = new URL("../../dist", import.meta.url).pathname;
// spark.wasm may be absent from dist/ after a cached (output-restoring) build — restore it from
// @qntx/spark-wasm before serving, the same package copy-spark-wasm.ts reads.
{
  const out = join(distDir, "spark.wasm");
  if (!existsSync(out)) {
    const wasmPkg = join(require.resolve("@qntx/spark-wasm/package.json"), "..");
    copyFileSync(join(wasmPkg, "dist", "spark.wasm"), out);
  }
}
const production = process.argv[2] === "build";

if (production) {
  const outDir = mkdtempSync(join(tmpdir(), "qntx-wallet-worker-"));
  await build({
    configFile: false,
    root,
    build: { outDir },
    logLevel: "warn",
  });
  // vite emits kernel.worker.js as an asset next to the page bundle; the worker fetches
  // ./spark.wasm relative to its own URL, so the wasm must sit beside the emitted worker.
  // Same-origin chunks: the code-split spark runtime and spark.wasm are fetched relative to the
  // emitted worker asset, so every dist/ payload file must sit beside it.
  // spark.wasm may be absent from dist/ after a cached (output-restoring) build — source it
  // from @qntx/spark-wasm, the same package copy-spark-wasm.ts reads.
  const wasmPkg = join(require.resolve("@qntx/spark-wasm/package.json"), "..");
  const payloads: Array<[string, string]> = [
    [join(wasmPkg, "dist", "spark.wasm"), "spark.wasm"],
    ...readdirSync(distDir)
      .filter((f) => f.endsWith(".js"))
      .map((f): [string, string] => [join(distDir, f), f]),
  ];
  for (const dir of [outDir, join(outDir, "assets")]) {
    if (existsSync(dir)) {
      for (const [src, name] of payloads) {
        copyFileSync(src, join(dir, name));
      }
    }
  }
  const server = await preview({
    configFile: false,
    root,
    build: { outDir },
    preview: {
      // localhost, not 127.0.0.1 — WebAuthn rejects IP literals as rpId ("invalid domain").
      host: "localhost",
      port: 4175,
      strictPort: true,
      headers: { "Content-Security-Policy": CSP },
    },
    logLevel: "warn",
  });
  server.printUrls();
} else {
  const server = await createServer({
    configFile: false,
    root,
    // No runtime dependency discovery: a late discovery makes vite re-optimize and reload the
    // page mid-test ("execution context was destroyed"). Every page dependency is plain ESM.
    optimizeDeps: { noDiscovery: true, exclude: ["@qntx/wallet-worker"] },
    server: {
      // localhost, not 127.0.0.1 — WebAuthn rejects IP literals as rpId ("invalid domain").
      host: "localhost",
      port: 4174,
      strictPort: true,
      headers: { "Content-Security-Policy": CSP },
      // No file watching: an fs change (another test task writing dist/ or a cached build
      // restore) would broadcast a full page reload and destroy the page's execution context
      // mid-test.
      watch: null,
      hmr: false,
    },
    logLevel: "warn",
  });
  await server.listen();
}
