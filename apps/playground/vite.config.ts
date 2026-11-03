import { defineConfig } from "vite-plus";

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "connect-src 'self' https://*.spark.lightspark.com https://api.lightspark.com; " +
  "style-src 'self' 'unsafe-inline'";

export default defineConfig({
  plugins: [
    {
      name: "workers-headers",
      // The built site is served as Workers static assets (harness relying
      // party): emit the same CSP the dev and preview servers send.
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "_headers",
          source: `/*\n  content-security-policy: ${CSP}\n`,
        });
      },
    },
  ],
  server: {
    headers: { "content-security-policy": CSP },
  },
  preview: {
    headers: { "content-security-policy": CSP },
  },
  build: {
    target: "es2022",
  },
});
