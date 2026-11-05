import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  pack: {
    entry: { index: "src/index.ts" },
    tsconfig: "tsconfig.src.json",
    deps: {
      neverBundle: ["@qntx/wallet", "@qntx/wallet-kernel", "@qntx/nostr", "cborg"],
    },
    dts: {
      generator: "tsgo",
    },
    sourcemap: true,
  },
  test: {
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
