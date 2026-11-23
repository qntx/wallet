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
 * Flags every Hermes invocation in the repo must pass, at compile time (hermesc) and at run time
 * (the bare `hermes` CLI) alike. Without `-Xes6-block-scoping` — off by default — loop-scoped
 * `let`/`const` share one binding across iterations and closures capture the last iteration's
 * value; a single call site missing it silently runs different semantics from everything else. The
 * kernel also fails closed at start (`startKernel` in packages/wallet-kernel/src/kernel.ts) and
 * scripts/check-hermes-flags.test.ts pins every call site to this list. The shipped
 * compile-kernel.mjs cannot import repo scripts, so it keeps its own literal of the same flag.
 */
export const HERMES_FLAGS: ReadonlyArray<string> = ["-Xes6-block-scoping"];

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
