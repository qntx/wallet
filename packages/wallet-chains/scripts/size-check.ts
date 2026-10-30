/// <reference types="node" />
/** Bundles each family's /family + /family/sign minified and enforces the gzip budget. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    splitting?: boolean;
  }) => Promise<BunBuildOutput>;
};

const root = fileURLToPath(new URL("..", import.meta.url));

const FAMILIES = [
  { name: "evm", budget: 120 * 1024 },
  { name: "solana", budget: 80 * 1024 },
  { name: "bitcoin", budget: 60 * 1024 },
] as const;

type FamilyResult = {
  name: string;
  budget: number;
  total: number;
  outputs: number;
};

const measure = async (name: string, budget: number): Promise<FamilyResult> => {
  const result = await Bun.build({
    entrypoints: [resolve(root, `src/${name}/index.ts`), resolve(root, `src/${name}/sign.ts`)],
    target: "browser",
    format: "esm",
    minify: true,
    splitting: true,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(String(log));
    }
    throw new Error(`chains-size ${name}: bundle failed`);
  }
  const texts = await Promise.all(result.outputs.map(async (output) => output.text()));
  const total = texts.reduce((sum, text) => sum + gzipSync(Buffer.from(text)).length, 0);
  return { name, budget, total, outputs: result.outputs.length };
};

async function main(): Promise<number> {
  let failed = false;
  try {
    const results = await Promise.all(
      FAMILIES.map(async ({ name, budget }) => measure(name, budget)),
    );
    for (const { name, budget, total, outputs } of results) {
      console.log(
        `chains-size ${name}: ${total} B gzipped across ${outputs} entries (budget ${budget} B)`,
      );
      if (total > budget) {
        console.error(`chains-size ${name}: budget exceeded`);
        failed = true;
      }
    }
  } catch {
    failed = true;
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
