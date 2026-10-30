/// <reference types="node" />
/** Bundles tests/hermes/entry.ts (chains EVM vectors) and runs it in bare Hermes. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const outfile = resolve(root, ".hermes-chains.iife.js");

async function main(): Promise<number> {
  const hermes = process.env.HERMES;
  if (hermes === undefined || hermes === "") {
    console.error("set HERMES to the hermes binary");
    return 1;
  }
  const result = await Bun.build({
    entrypoints: [resolve(root, "tests/hermes/entry.ts")],
    target: "browser",
    format: "iife",
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(String(log));
    }
    return 1;
  }
  const bundle = result.outputs.find((o) => o.kind === "entry-point");
  if (!bundle) {
    console.error("bun build produced no entry-point output");
    return 1;
  }
  await Bun.write(outfile, bundle);
  const run = Bun.spawnSync([hermes, outfile], { stdout: "pipe", stderr: "pipe" });
  const out = `${run.stdout.toString()}\n${run.stderr.toString()}`;
  console.log(out);
  if (!out.includes("HERMES_CHAINS_OK")) {
    console.error("chains hermes smoke failed");
    return 1;
  }
  return 0;
}

process.exitCode = await main();
