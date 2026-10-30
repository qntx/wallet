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
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// wallet-worker manifest), the injected backends' ABI pins, plus the bundle's
// SHA-256. `@qntx/spark` resolves through the kernel package — the ABI version
// recorded is the one the bundle was built against.
const kernelPkg: unknown = JSON.parse(
  readFileSync(resolve(root, "packages/wallet-kernel/package.json"), "utf8"),
);
const nativePkg: unknown = JSON.parse(
  readFileSync(resolve(root, "packages/wallet-native/package.json"), "utf8"),
);
const nativeDevDeps = stringMap(isRecord(nativePkg) ? nativePkg["devDependencies"] : undefined);
const sparkRequire = createRequire(resolve(root, "packages/wallet-kernel/package.json"));
const sparkCrypto: unknown = await import(
  pathToFileURL(sparkRequire.resolve("@qntx/spark/crypto")).href
);
const isSparkCrypto = (value: unknown): value is { SPARK_ABI_VERSION: number } =>
  isRecord(value) && typeof value["SPARK_ABI_VERSION"] === "number";
if (!isSparkCrypto(sparkCrypto)) {
  throw new TypeError("@qntx/spark/crypto: SPARK_ABI_VERSION missing");
}
const { SPARK_ABI_VERSION } = sparkCrypto;
const nostrKernel: unknown = await import(
  pathToFileURL(resolve(root, "packages/wallet-native/kernel/nostr.ts")).href
);
const isNostrKernel = (value: unknown): value is { NOSTR_NATIVE_ABI_VERSION: number } =>
  isRecord(value) && typeof value["NOSTR_NATIVE_ABI_VERSION"] === "number";
if (!isNostrKernel(nostrKernel)) {
  throw new TypeError("kernel/nostr: NOSTR_NATIVE_ABI_VERSION missing");
}
const { NOSTR_NATIVE_ABI_VERSION } = nostrKernel;
const manifest = {
  protocol: PROTOCOL_VERSION,
  vaultFormat: VAULT_FORMAT,
  backends: {
    spark: { abiVersion: SPARK_ABI_VERSION },
    nostr: { abiVersion: NOSTR_NATIVE_ABI_VERSION },
  },
  libraries: manifestLibraries({
    dependencies: stringMap(isRecord(kernelPkg) ? kernelPkg["dependencies"] : undefined),
    backendDependencies: {
      "@qntx/spark-native": nativeDevDeps["@qntx/spark-native"] ?? "",
      "@qntx/nostr-native": nativeDevDeps["@qntx/nostr-native"] ?? "",
    },
    lockPackages: lockPackages(parseLockfile(readFileSync(resolve(root, "bun.lock"), "utf8"))),
  }),
  bundles: manifestBundles([{ file: "kernel-entry.js", bytes }]),
};
const manifestPath = resolve(outDir, "kernel.manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`kernel.manifest.json: ${manifest.libraries.length} libraries, 1 bundle`);
