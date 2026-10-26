import { createServer } from "vite";

const server = await createServer({
  root: new URL("..", import.meta.url).pathname,
  // The recursive test run shares node_modules/.vite with other packages' dev tooling.
  cacheDir: `../../.cache/playground-vite-${process.pid}`,
  optimizeDeps: { force: true },
  server: { port: 5417, strictPort: true },
});
await server.listen();
process.stdout.write("playground dev server on :5417\n");
