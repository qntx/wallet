/// <reference types="node" />
/**
 * Bundle tests/hermes/card.ts into a single classic script and run it on the Hermes CLI (`HERMES`
 * env var). Pass = stdout contains `HERMES_CARD_OK`; Hermes exits 0 on unhandled async rejections,
 * so the marker is the only contract. The full Hermes output is printed either way.
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

const runOne = async (hermes: string, name: "card" | "ledger", marker: string): Promise<number> => {
  const outfile = resolve(root, `.hermes-${name}.iife.js`);
  // Same pipeline as scripts/build-kernel.ts: the es2017 target lowers class static blocks
  // (ox emits them) that bare Hermes cannot parse.
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      lib: {
        entry: resolve(root, `tests/hermes/${name}.ts`),
        formats: ["iife"],
        name: `qntxHermes${name}`,
        fileName: () => `.hermes-${name}.iife.js`,
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
  if (proc.exitCode !== 0 || !out.includes(marker)) {
    console.error(`hermes ${name} smoke failed (exit ${proc.exitCode}): no ${marker}`);
    return 1;
  }
  return 0;
};

async function main(): Promise<number> {
  const hermes = process.env.HERMES;
  if (hermes === undefined || hermes === "") {
    console.error("set HERMES to the hermes binary");
    return 1;
  }
  const card = await runOne(hermes, "card", "HERMES_CARD_OK");
  if (card !== 0) {
    return card;
  }
  return runOne(hermes, "ledger", "HERMES_LEDGER_OK");
}

process.exitCode = await main();
