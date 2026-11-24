/// <reference types="node" />
/**
 * Bundles the tests/hermes entries (the Fiat24 layer and the QR layer, both without a kernel) and
 * runs each in bare Hermes.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HERMES_FLAGS } from "../../../scripts/kernel-build-config.ts";

type BunBuildOutput = {
  success: boolean;
  logs: ReadonlyArray<{ toString: () => string }>;
  outputs: ReadonlyArray<{ kind: string }>;
};
declare const Bun: {
  build: (options: {
    entrypoints: string[];
    target: "browser";
    format: "iife";
  }) => Promise<BunBuildOutput>;
  write: (path: string, data: unknown) => Promise<unknown>;
  spawnSync: (
    cmd: ReadonlyArray<string>,
    options: { stdout: "pipe"; stderr: "pipe" },
  ) => { exitCode: number; stdout: { toString: () => string }; stderr: { toString: () => string } };
};

const root = fileURLToPath(new URL("..", import.meta.url));

const ENTRIES: ReadonlyArray<{
  readonly name: string;
  readonly entry: string;
  readonly ok: string;
}> = [
  { name: "fiat24", entry: "tests/hermes/fiat24-entry.ts", ok: "HERMES_FIAT24_OK" },
  { name: "qr", entry: "tests/hermes/qr-entry.ts", ok: "HERMES_QR_OK" },
];

async function main(): Promise<number> {
  const hermes = process.env.HERMES;
  if (hermes === undefined || hermes === "") {
    console.error("set HERMES to the hermes binary");
    return 1;
  }
  const runEntry = async ({ name, entry, ok }: (typeof ENTRIES)[number]): Promise<boolean> => {
    const result = await Bun.build({
      entrypoints: [resolve(root, entry)],
      target: "browser",
      format: "iife",
    });
    if (!result.success) {
      for (const log of result.logs) {
        console.error(String(log));
      }
      return false;
    }
    const bundle = result.outputs.find((o) => o.kind === "entry-point");
    if (!bundle) {
      console.error(`bun build produced no entry-point output for ${entry}`);
      return false;
    }
    const outfile = resolve(root, `.hermes-${name}.iife.js`);
    await Bun.write(outfile, bundle);
    const run = Bun.spawnSync([hermes, ...HERMES_FLAGS, outfile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${run.stdout.toString()}\n${run.stderr.toString()}`;
    console.log(out);
    if (!out.includes(ok)) {
      console.error(`${entry} hermes smoke failed`);
      return false;
    }
    return true;
  };
  const results = await Promise.all(ENTRIES.map(runEntry));
  if (results.some((ok) => !ok)) {
    return 1;
  }
  return 0;
}

process.exitCode = await main();
