import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const config: UserConfig = defineConfig({
  pack: {
    entry: {
      browser: "src/browser/index.ts",
      node: "src/node/index.ts",
    },
    dts: {
      generator: "tsgo",
      // The package tsconfig splits src by platform lib (browser/worker are nested
      // programs); declaration emit for both entries uses one merged program instead.
      tsconfig: "tsconfig.pack.json",
    },
    deps: {
      neverBundle: ["@qntx/wallet"],
      // These entries are the published host wrappers; the kernel's self-contained
      // bundles come from bun build (scripts/build-kernel), not vp pack.
      onlyBundle: [],
    },
    sourcemap: true,
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      // The two worker entries are one call each into browser-kernel.ts and node-kernel.ts and
      // only run inside a real worker, where V8 coverage is not collected: the Node tests and
      // the Playwright suite exercise them through the built bundles.
      exclude: ["src/worker/worker.ts", "src/worker/node.ts"],
      thresholds: { lines: 90, branches: 79, functions: 89, statements: 90 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          globalSetup: ["tests/setup.ts"],
          // Playwright specs live in tests/browser and are not part of `vp test`.
          include: ["tests/*.test.ts"],
        },
      },
      {
        // The Web enclave's own code — the IndexedDB store, the kernel wiring and the page host —
        // run from source in a real browser, where their platform APIs exist.
        extends: true,
        // Loaded with the first Spark call; pre-bundled so Vite does not reload the test page.
        optimizeDeps: { include: ["@qntx/spark-wasm/browser"] },
        test: {
          name: "web",
          include: ["tests/web/*.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});

export default config;
