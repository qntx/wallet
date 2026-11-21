import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests run on Node, where the runtime module does not exist.
    alias: { "cloudflare:workers": "./tests/stubs/cloudflare-workers.ts" },
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      thresholds: { lines: 91, branches: 86, functions: 84, statements: 90 },
    },
  },
});

export default config;
