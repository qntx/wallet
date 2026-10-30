import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
/// <reference types="node" />
/** Bundles ./evm and ./evm/sign minified, gzips, and fails above 120 KB total. */
import { gzipSync } from "node:zlib";

type BunBuildOutput = {
  success: boolean;
  logs: ReadonlyArray<{ toString: () => string }>;
  outputs: ReadonlyArray<{ kind: string; text: () => Promise<string> }>;
};
declare const Bun: {
  build: (options: {
    entrypoints: string[];
    target: "browser";
    format: "esm";
    minify: boolean;
  }) => Promise<BunBuildOutput>;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const BUDGET = 120 * 1024;

async function main(): Promise<number> {
  const result = await Bun.build({
    entrypoints: [resolve(root, "src/evm/index.ts"), resolve(root, "src/evm/sign.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(String(log));
    }
    return 1;
  }
  let total = 0;
  for (const output of result.outputs) {
    total += gzipSync(Buffer.from(await output.text())).length;
  }
  console.log(
    `chains-size: ${total} B gzipped across ${result.outputs.length} entries (budget ${BUDGET} B)`,
  );
  if (total > BUDGET) {
    console.error("chains-size: budget exceeded");
    return 1;
  }
  return 0;
}

process.exitCode = await main();
