import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  pack: {
    entry: { index: "src/index.ts", "secure-input": "src/secure-input.ts", cloud: "src/cloud.ts" },
    tsconfig: "tsconfig.src.json",
    deps: {
      neverBundle: [
        "@qntx/wallet",
        "@qntx/wallet-engine",
        "@qntx/wallet-kernel",
        "@qntx/nostr",
        "cborg",
      ],
    },
    dts: {
      generator: "tsgo",
    },
    sourcemap: true,
  },
  test: {
    // Cross-package imports must see the engine source — the conformance suite asserts
    // `instanceof` on its classes, so @qntx/wallet-engine resolves to src, not dist.
    alias: {
      "@qntx/wallet-engine": new URL("../wallet-engine/src/index.ts", import.meta.url).pathname,
    },
    include: ["tests/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      thresholds: { lines: 94, branches: 87, functions: 90, statements: 93 },
    },
  },
});

export default config;
