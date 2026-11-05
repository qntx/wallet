import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  // Two programs: the platform-neutral entry and the DOM-scoped IndexedDB entry.
  pack: [
    {
      entry: {
        index: "src/index.ts",
        connect: "src/connect/index.ts",
        "gateway-contract": "src/gateway/contract/index.ts",
      },
      tsconfig: "tsconfig.src.json",
      deps: { onlyBundle: [] },
      dts: { generator: "tsgo" },
      sourcemap: true,
    },
    {
      entry: { idb: "src/idb/indexeddb.ts" },
      tsconfig: "tsconfig.idb.json",
      deps: { onlyBundle: [] },
      dts: { generator: "tsgo" },
      sourcemap: true,
    },
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/connect/inject.generated.ts"],
      thresholds: { lines: 84, branches: 75, functions: 85, statements: 84 },
    },
  },
});

export default config;
