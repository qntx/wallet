/**
 * Serves the static test page. Dev mode (`bun ./serve.ts`) uses vite-plus's dev server on 4174 (the
 * brief's `optimizeDeps.exclude` only exists on the dev server). Build mode (`bun ./serve.ts
 * build`) runs `vite build` on the same page root into a temp dir and serves it with `vite preview`
 * on 4175 — the production path consumers ship: the page imports `@qntx/wallet-worker/browser` from
 * the built dist, and `new URL("kernel.worker.js", import.meta.url)` must resolve against the
 * emitted bundle.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build, createServer, preview } from "vite";

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
const root = new URL("page", import.meta.url).pathname;
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
  const distDir = new URL("../../dist", import.meta.url).pathname;
  // Same-origin chunks: the code-split spark runtime and spark.wasm are fetched relative to the
  // emitted worker asset, so every dist/ payload file must sit beside it.
  const payloads = ["spark.wasm", ...readdirSync(distDir).filter((f) => f.endsWith(".js"))];
  for (const dir of [outDir, join(outDir, "assets")]) {
    if (existsSync(dir)) {
      for (const file of payloads) {
        copyFileSync(join(distDir, file), join(dir, file));
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
    optimizeDeps: { exclude: ["@qntx/wallet-worker"] },
    server: {
      // localhost, not 127.0.0.1 — WebAuthn rejects IP literals as rpId ("invalid domain").
      host: "localhost",
      port: 4174,
      strictPort: true,
      headers: { "Content-Security-Policy": CSP },
    },
    logLevel: "warn",
  });
  await server.listen();
}
