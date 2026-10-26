import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      idb: "src/idb/indexeddb.ts",
    },
    dts: {
      generator: "tsgo",
    },
    sourcemap: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "text-summary"], include: ["src/**/*.ts"] },
  },
});

export default config;
