import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      evm: "src/evm/index.ts",
      "evm-sign": "src/evm/sign.ts",
      solana: "src/solana/index.ts",
      "solana-sign": "src/solana/sign.ts",
      bitcoin: "src/bitcoin/index.ts",
      "bitcoin-sign": "src/bitcoin/sign.ts",
      networks: "src/networks.ts",
    },
    deps: {
      // Every third-party import must resolve as an external dependency; a src import that
      // lands in dist because it is undeclared is a packaging bug.
      onlyBundle: [],
    },
    dts: {
      generator: "tsgo",
    },
    sourcemap: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      thresholds: { lines: 89, branches: 79, functions: 95, statements: 89 },
    },
  },
});

export default config;
