import { join } from "node:path";

import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

/**
 * The package `unit` project only includes `tests/*.test.ts`; this config lets the review PoCs
 * under tests/review/ run via `bunx vp test -c tests/review/vitest.config.ts (engine)`.
 */
const config: UserConfig = defineConfig({
  root: join(import.meta.dirname, "../.."),
  test: { include: ["tests/review/*.test.ts"] },
});

export default config;
