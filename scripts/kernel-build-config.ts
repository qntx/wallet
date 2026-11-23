/**
 * The one source of truth for the kernel bundle's build: `build-kernel.ts` emits the committed
 * artifact with these options and `check-bundles.ts` builds every `enclave` entry under the same
 * resolve conditions so the boundary check judges the same modules the real bundle loads.
 *
 * `KERNEL_BUILD_CONDITIONS` is `defaultClientConditions` from the installed vite-plus-core (1.4.0:
 * `module`, `browser`, `development|production` — the last is the placeholder vite resolves to
 * `production` in build mode) — the conditions the kernel lib build already uses implicitly. They
 * are pinned explicitly so the bundle boundary check can evaluate `exports` exactly the way the
 * real build does.
 */
import type { InlineConfig } from "vite";

export const KERNEL_BUILD_CONDITIONS: ReadonlyArray<string> = [
  "module",
  "browser",
  "development|production",
];

/**
 * The build() options of one classic-script kernel bundle. Nothing may stay external: the bytecode
 * runs in a bare Hermes runtime with no module loader, so deps and peers are inlined. `target:
 * "es2017"` is not cosmetic — rolldown lowers `async function*` (ES2018) to helpers, and hermesc
 * rejects the raw syntax.
 */
const scriptConfig = (
  entry: string,
  outDir: string,
  name: string,
  fileName: () => string,
): InlineConfig => ({
  configFile: false,
  logLevel: "warn",
  build: {
    // One iife classic-script bundle — hermesc needs a classic script, not an ES module.
    lib: { entry, formats: ["iife"], name, fileName },
    outDir,
    emptyOutDir: false,
    minify: false,
    target: "es2017",
    rolldownOptions: { external: [] },
  },
  resolve: { conditions: [...KERNEL_BUILD_CONDITIONS] },
});

/** The build() options of the committed kernel artifact. */
export const kernelBuildConfig = (entry: string, outDir: string): InlineConfig =>
  scriptConfig(entry, outDir, "qntxKernelEntry", () => "kernel-entry.js");

/**
 * The same options for an apps/harness probe: probes bundle kernel source and are compiled by
 * hermesc, so they need the identical es2017 lowering (`Bun.build` emits `async function*` raw).
 */
export const probeBuildConfig = (entry: string, outDir: string, name: string): InlineConfig =>
  scriptConfig(entry, outDir, name, () => `${name}.js`);
