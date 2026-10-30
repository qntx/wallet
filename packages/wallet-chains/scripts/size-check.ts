import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
/// <reference types="node" />
/** Bundles each family's /family + /family/sign minified and enforces the gzip budget. */
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

const FAMILIES = [
  { name: "evm", budget: 120 * 1024 },
  { name: "solana", budget: 80 * 1024 },
] as const;

async function main(): Promise<number> {
  let failed = false;
  for (const { name, budget } of FAMILIES) {
    const result = await Bun.build({
      entrypoints: [resolve(root, `src/${name}/index.ts`), resolve(root, `src/${name}/sign.ts`)],
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
    const texts = await Promise.all(result.outputs.map(async (output) => output.text()));
    const total = texts.reduce((sum, text) => sum + gzipSync(Buffer.from(text)).length, 0);
    console.log(
      `chains-size ${name}: ${total} B gzipped across ${result.outputs.length} entries (budget ${budget} B)`,
    );
    if (total > budget) {
      console.error(`chains-size ${name}: budget exceeded`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
