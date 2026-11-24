/// <reference types="node" />
/**
 * Bundle each tests/hermes entry into a single classic script and run it on the Hermes CLI
 * (`HERMES` env var). Pass = stdout contains the entry's marker (`HERMES_CARD_OK`,
 * `HERMES_ONEKEY_OK`); Hermes exits 0 on unhandled async rejections, so the marker is the only
 * contract. The full Hermes output is printed either way.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { HERMES_FLAGS } from "../../../scripts/kernel-build-config.ts";

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

const ENTRIES = [
  { entry: "card", marker: "HERMES_CARD_OK" },
  { entry: "ledger", marker: "HERMES_LEDGER_OK" },
  { entry: "keystone", marker: "HERMES_KEYSTONE_OK" },
  { entry: "onekey", marker: "HERMES_ONEKEY_OK" },
] as const;

async function main(): Promise<number> {
  const hermes = process.env.HERMES;
  if (hermes === undefined || hermes === "") {
    console.error("set HERMES to the hermes binary");
    return 1;
  }

  const results = await Promise.all(
    ENTRIES.map(async ({ entry, marker }) => {
      // Same pipeline as scripts/build-kernel.ts: the es2017 target lowers class static blocks
      // (ox emits them) that bare Hermes cannot parse.
      await build({
        configFile: false,
        logLevel: "warn",
        build: {
          lib: {
            entry: resolve(root, `tests/hermes/${entry}.ts`),
            formats: ["iife"],
            name: `qntxHermes${entry}`,
            fileName: () => `.hermes-${entry}.iife.js`,
          },
          outDir: root,
          emptyOutDir: false,
          minify: false,
          target: "es2017",
          rolldownOptions: { external: [] },
        },
      });

      const proc = Bun.spawnSync(
        [hermes, ...HERMES_FLAGS, resolve(root, `.hermes-${entry}.iife.js`)],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = proc.stdout.toString() + proc.stderr.toString();
      process.stdout.write(out);
      if (proc.exitCode !== 0 || !out.includes(marker)) {
        console.error(`hermes ${entry} smoke failed (exit ${proc.exitCode}): no ${marker}`);
        return false;
      }
      return true;
    }),
  );
  return results.every(Boolean) ? 0 : 1;
}

process.exitCode = await main();
