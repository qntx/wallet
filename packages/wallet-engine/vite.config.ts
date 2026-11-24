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
        apps: "src/apps/index.ts",
        "apps-fiat24": "src/apps/fiat24/index.ts",
        "apps-hyperliquid": "src/apps/hyperliquid/index.ts",
        "apps-polymarket": "src/apps/polymarket/index.ts",
        walletconnect: "src/walletconnect/index.ts",
        push: "src/push/index.ts",
      },
      tsconfig: "tsconfig.src.json",
      // Keep dependencies external in declarations too — the walletconnect entry's
      // @walletconnect/@reown dts pull in pino's CJS declarations, which cannot be inlined.
      deps: { onlyBundle: [], dts: { neverBundle: true } },
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
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/connect/inject.generated.ts"],
      thresholds: { lines: 84, branches: 75, functions: 85, statements: 84 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // The speculos e2e needs the Ledger app containers from scripts/ledger/speculos.ts and
          // is not part of `vp test` — it runs under `test:speculos`.
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/signers-e2e/ledger.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "speculos",
          include: ["tests/signers-e2e/ledger.test.ts"],
          testTimeout: 300_000,
        },
      },
    ],
  },
});

export default config;
