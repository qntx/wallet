/// <reference types="node" />
/**
 * Bundle each tests/hermes/*.ts entry into a single classic script and run it on the Hermes CLI
 * (`HERMES` env var). Pass = every entry's stdout contains its `HERMES_*_OK` marker; Hermes exits 0
 * on unhandled async rejections, so the marker is the only contract. The full Hermes output is
 * printed either way.
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

const SMOKES: ReadonlyArray<{
  readonly entry: string;
  readonly name: string;
  readonly marker: string;
}> = [
  { entry: "tests/hermes/card.ts", name: "card", marker: "HERMES_CARD_OK" },
  { entry: "tests/hermes/keystone.ts", name: "keystone", marker: "HERMES_KEYSTONE_OK" },
];

async function main(): Promise<number> {
  const hermes = process.env.HERMES;
  if (hermes === undefined || hermes === "") {
    console.error("set HERMES to the hermes binary");
    return 1;
  }

  // Same pipeline as scripts/build-kernel.ts: the es2017 target lowers class static blocks
  // (ox emits them) that bare Hermes cannot parse.
  await Promise.all(
    SMOKES.map(async (smoke) =>
      build({
        configFile: false,
        logLevel: "warn",
        build: {
          lib: {
            entry: resolve(root, smoke.entry),
            formats: ["iife"],
            name: `qntxHermes${smoke.name}`,
            fileName: () => `.hermes-${smoke.name}.iife.js`,
          },
          outDir: root,
          emptyOutDir: false,
          minify: false,
          target: "es2017",
          rolldownOptions: { external: [] },
        },
      }),
    ),
  );

  for (const smoke of SMOKES) {
    const proc = Bun.spawnSync([hermes, resolve(root, `.hermes-${smoke.name}.iife.js`)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    process.stdout.write(out);
    if (proc.exitCode !== 0 || !out.includes(smoke.marker)) {
      console.error(`hermes smoke failed (exit ${proc.exitCode}): no ${smoke.marker}`);
      return 1;
    }
  }
  return 0;
}

process.exitCode = await main();
