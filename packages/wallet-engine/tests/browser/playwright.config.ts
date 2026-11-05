import { defineConfig } from "@playwright/test";
import type { PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = defineConfig({
  globalSetup: "./global-setup.ts",
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: {
    baseURL: "http://localhost:4176",
    headless: true,
  },
  webServer: [
    {
      command: "bun ./serve.ts",
      // Probe the address the server binds; "localhost" may resolve to the other loopback family.
      url: "http://127.0.0.1:4176/connect.html",
      reuseExistingServer: process.env["CI"] === undefined,
    },
  ],
  // The injected provider speaks postMessage only — no WebAuthn/CDP dependency — so every engine
  // runs the spec.
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

export default config;
