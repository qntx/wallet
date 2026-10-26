import { defineConfig } from "vite-plus";

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "connect-src 'self' https://*.spark.lightspark.com https://api.lightspark.com; " +
  "style-src 'self' 'unsafe-inline'";

export default defineConfig({
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
