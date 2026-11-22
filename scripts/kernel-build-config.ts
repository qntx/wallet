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
 * The build() options of the committed kernel artifact. Nothing may stay external: the bytecode
 * runs in a bare Hermes runtime with no module loader, so deps and peers are inlined.
 */
export const kernelBuildConfig = (entry: string, outDir: string): InlineConfig => ({
  configFile: false,
  logLevel: "warn",
  build: {
    // One iife classic-script bundle — hermesc needs a classic script, not an ES module.
    lib: { entry, formats: ["iife"], name: "qntxKernelEntry", fileName: () => "kernel-entry.js" },
    outDir,
    emptyOutDir: false,
    minify: false,
    target: "es2017",
    rolldownOptions: { external: [] },
  },
  resolve: { conditions: [...KERNEL_BUILD_CONDITIONS] },
});
