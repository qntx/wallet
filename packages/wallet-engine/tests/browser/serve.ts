/** Serves the connect test page on :4176 with vite's dev server (viem + the injected provider). */
import { createServer } from "vite";

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const root = new URL("page", import.meta.url).pathname;

const server = await createServer({
  root,
  configFile: false,
  logLevel: "warn",
  // The IPv4 loopback explicitly, matching the readiness probe (see playwright.config.ts).
  server: {
    host: "127.0.0.1",
    port: 4176,
    strictPort: true,
    headers: { "content-security-policy": CSP },
  },
});
await server.listen();
process.stdout.write("connect test page on http://localhost:4176\n");
