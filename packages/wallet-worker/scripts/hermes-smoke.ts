/// <reference types="node" />
/**
 * Bundle tests/hermes/entry.ts into a single classic script and run it on the Hermes CLI (`HERMES`
 * env var). Pass = stdout contains `HERMES_SMOKE_OK`; Hermes exits 0 on unhandled async rejections,
 * so the marker is the only contract. The full Hermes output is printed either way — including the
 * HERMES_GLOBALS_* probe lines.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  write: (path: string, data: unknown) => Promise<unknown>;
  spawnSync: (
    cmd: ReadonlyArray<string>,
    options: { stdout: "pipe"; stderr: "pipe" },
  ) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = resolve(root, ".hermes-smoke.iife.js");

async function main(): Promise<number> {
  const hermes = process.env["HERMES"];
  if (hermes === undefined || hermes === "") {
    console.error("set HERMES to the hermes binary");
    return 1;
  }

  // Same pipeline as scripts/build-kernel.ts: the es2017 target lowers class static blocks
  // (ox emits them) that bare Hermes cannot parse.
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      lib: {
        entry: resolve(root, "tests/hermes/entry.ts"),
        formats: ["iife"],
        name: "qntxHermesSmoke",
        fileName: () => ".hermes-smoke.iife.js",
      },
      outDir: root,
      emptyOutDir: false,
      minify: false,
      target: "es2017",
      rolldownOptions: { external: [] },
    },
  });

  const proc = Bun.spawnSync([hermes, outfile], { stdout: "pipe", stderr: "pipe" });
  const out = proc.stdout.toString() + proc.stderr.toString();
  process.stdout.write(out);
  if (proc.exitCode !== 0 || !out.includes("HERMES_SMOKE_OK")) {
    console.error(`hermes smoke failed (exit ${proc.exitCode}): no HERMES_SMOKE_OK`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
