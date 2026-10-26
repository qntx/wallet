import { createServer } from "vite";

const server = await createServer({
  root: new URL("..", import.meta.url).pathname,
  server: { port: 5417, strictPort: true },
});
await server.listen();
process.stdout.write("playground dev server on :5417\n");
