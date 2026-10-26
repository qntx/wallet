import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  use: { baseURL: "http://localhost:5417" },
  webServer: {
    command: "bun tests/serve.ts",
    url: "http://localhost:5417",
    reuseExistingServer: process.env.CI === undefined,
    cwd: new URL("..", import.meta.url).pathname,
  },
});
