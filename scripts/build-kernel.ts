/**
 * Build the kernel runtime payload for `@qntx/wallet-native`: bundle `kernel/kernel-entry.ts` into
 * one classic script with the repo's pinned bundler (rolldown via vite-plus — deterministic across
 * machines, unlike `bun build` whose output varies by bun version) and emit
 * `kernel/generated/kernel-entry.js` plus `kernel/generated/kernel.manifest.json`.
 *
 * Bytecode is deliberately NOT compiled here: hermesc output is not reproducible across machines
 * and Hermes only loads its own bytecode version, so the consuming app compiles the committed JS
 * with its own hermesc at build time (`packages/wallet-native/scripts/compile-kernel.mjs`). The
 * runtime SHA-256 check was removed with the runtime integrity story — the manifest SHA pins the
 * bundle, and `KernelRuntime` still verifies the bytecode magic/version.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { VAULT_FORMAT } from "../packages/wallet-kernel/src/vault/store.ts";
import { PROTOCOL_VERSION } from "../packages/wallet/src/protocol/index.ts";
import {
  isRecord,
  lockPackages,
  manifestBundles,
  manifestLibraries,
  parseLockfile,
  stringMap,
} from "./kernel-manifest.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = resolve(root, "packages/wallet-native/kernel/kernel-entry.ts");
const outDir = resolve(root, "packages/wallet-native/kernel/generated");

mkdirSync(outDir, { recursive: true });

// One iife classic-script bundle — hermesc needs a classic script, not an ES module.
await build({
  configFile: false,
  logLevel: "warn",
  build: {
    lib: { entry, formats: ["iife"], name: "qntxKernelEntry", fileName: () => "kernel-entry.js" },
    outDir,
    emptyOutDir: false,
    minify: false,
    target: "es2017",
    // Nothing may stay external: the bytecode runs in a bare Hermes runtime with
    // no module loader — deps+peers in package.json must be inlined, not left as
    // IIFE parameters.
    rolldownOptions: { external: [] },
  },
});
const generated = resolve(outDir, "kernel-entry.js");
const bytes = readFileSync(generated);
const head = bytes.toString("utf8").slice(0, 2000);
if (/\(function\s*\([^)]+/.test(head) || head.includes("import ") || head.includes("require(")) {
  throw new Error(
    "kernel-entry.js is not self-contained: an externalized dependency leaked an IIFE parameter or import — check rolldownOptions.external",
  );
}
console.log(
  `kernel-entry.js: ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…`,
);

// Manifest: the exact-pinned registry libraries the kernel package inlines
// (workspace sources are bundled source, not libraries — same rule as the
// wallet-worker manifest), plus the bundle's SHA-256.
const kernelPkg: unknown = JSON.parse(
  readFileSync(resolve(root, "packages/wallet-kernel/package.json"), "utf8"),
);
const manifest = {
  protocol: PROTOCOL_VERSION,
  vaultFormat: VAULT_FORMAT,
  libraries: manifestLibraries({
    dependencies: stringMap(isRecord(kernelPkg) ? kernelPkg["dependencies"] : undefined),
    lockPackages: lockPackages(parseLockfile(readFileSync(resolve(root, "bun.lock"), "utf8"))),
  }),
  bundles: manifestBundles([{ file: "kernel-entry.js", bytes }]),
};
const manifestPath = resolve(outDir, "kernel.manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`kernel.manifest.json: ${manifest.libraries.length} libraries, 1 bundle`);
