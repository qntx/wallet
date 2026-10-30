/// <reference types="node" />
/** Bundles each family's /family + /family/sign minified and enforces the gzip budget. */
import { mkdirSync, rmSync } from "node:fs";
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
  /* Per-consumer semantics: bundle one synthetic entry that re-exports both
   * /family and /family/sign so shared dependencies are deduplicated exactly
   * as a real consumer's bundler would. */
  const dir = resolve(root, ".size-check");
  const entry = resolve(dir, `${name}.ts`);
  await Bun.write(
    entry,
    `export * from "../src/${name}/index.ts";\nexport * from "../src/${name}/sign.ts";\n`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: true,
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
    mkdirSync(resolve(root, ".size-check"), { recursive: true });
    const results = await Promise.all(
      FAMILIES.map(async ({ name, budget }) => measure(name, budget)),
    );
    rmSync(resolve(root, ".size-check"), { recursive: true, force: true });
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
