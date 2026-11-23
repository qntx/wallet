import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

// No build step: the kernel is bundled by the host packages, never packed.
const config: UserConfig = defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      thresholds: { lines: 87, branches: 79, functions: 87, statements: 87 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Speculos specs live in tests/speculos and are not part of `vp test` — they need
          // the Ledger app containers from scripts/ledger/speculos.ts.
          include: ["tests/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "speculos",
          include: ["tests/speculos/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});

export default config;
