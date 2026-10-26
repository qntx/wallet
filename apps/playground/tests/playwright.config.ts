import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  use: { baseURL: "http://localhost:5417" },
  webServer: {
    command: "node tests/serve.ts",
    url: "http://localhost:5417",
    timeout: 180_000,
    reuseExistingServer: true,
    cwd: new URL("..", import.meta.url).pathname,
  },
});
