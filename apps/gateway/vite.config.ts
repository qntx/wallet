import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

const config: UserConfig = defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});

export default config;
