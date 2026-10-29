import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  pack: {
    entry: { index: "src/index.ts" },
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
    coverage: { provider: "v8", reporter: ["text", "text-summary"], include: ["src/**/*.ts"] },
  },
});

export default config;
