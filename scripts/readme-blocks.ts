/// <reference types="node" />
/**
 * README fenced-block typecheck — runs in `bun run typecheck`:
 *
 * Every `ts / `typescript / ```tsx fenced block in README.md, MIGRATION.md and every
 * packages/​_​/README.md and apps/​_​/README.md is extracted into `tests/readme-blocks/` (a
 * gitignored generated dir, `*.ts`/`*.tsx` entries only) and compiled by `tsc --noEmit -p
 * tests/readme-blocks`. A block that is not meant to compile is re-fenced as `text`/`sh`/`json` in
 * the document rather than skipped.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join("tests", "readme-blocks");

/** `ts / `typescript / ```tsx fenced block: the fence's language tag and its body. */
export type ReadmeBlock = {
  readonly lang: "ts" | "typescript" | "tsx";
  readonly body: string;
};

const FENCE = /```(ts|typescript|tsx)\n([\s\S]*?)\n```/g;

const isBlockLang = (value: string | undefined): value is ReadmeBlock["lang"] =>
  value === "ts" || value === "typescript" || value === "tsx";

export function readmeBlocks(markdown: string): ReadonlyArray<ReadmeBlock> {
  const blocks: ReadmeBlock[] = [];
  for (const match of markdown.matchAll(FENCE)) {
    const [, lang, body] = match;
    if (!isBlockLang(lang) || body === undefined) {
      continue;
    }
    blocks.push({ lang, body });
  }
  return blocks;
}

/** `packages/wallet-engine/README.md` → `packages-wallet-engine-readme`, `README.md` → `readme`. */
const slug = (file: string): string => file.replace(/\.md$/, "").replaceAll("/", "-").toLowerCase();

const targets = (): string[] => {
  const files = ["README.md", "MIGRATION.md"];
  for (const dir of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const readme = join(dir, entry.name, "README.md");
      if (entry.isDirectory() && existsSync(join(ROOT, readme))) {
        files.push(readme);
      }
    }
  }
  return files;
};

const main = (): void => {
  const out = join(ROOT, OUT);
  mkdirSync(out, { recursive: true });
  /* Drop only stale generated snippets — tsconfig.json in the same dir is committed. */
  for (const entry of readdirSync(out)) {
    if (/\.tsx?$/.test(entry)) {
      rmSync(join(out, entry));
    }
  }
  let count = 0;
  for (const file of targets()) {
    const markdown = readFileSync(join(ROOT, file), "utf8");
    for (const [index, block] of readmeBlocks(markdown).entries()) {
      const ext = block.lang === "tsx" ? "tsx" : "ts";
      writeFileSync(
        join(out, `${slug(file)}-${String(index).padStart(2, "0")}.${ext}`),
        `// ${file} — fenced ${block.lang} block ${index}\n${block.body}\n`,
      );
      count += 1;
    }
  }
  console.log(`readme-blocks: wrote ${count} blocks to ${OUT}/`);
};

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  main();
}
