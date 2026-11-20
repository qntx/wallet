/* oxlint-disable eslint/no-console, unicorn/no-process-exit -- audit runner prints its results */
/**
 * R4-D1: every fenced ```ts block in MIGRATION.md claims to be a file under tests/migration/ (the
 * `[tests/migration/x.ts]` link on the line before the block). This script extracts each block,
 * diffs it against the referenced file byte-for-byte modulo a trailing newline, and prints one line
 * per block. Exit 1 on any mismatch, missing link, or unreferenced fixture.
 *
 * Run: bun audit/r4/migration-sync.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const doc = readFileSync(resolve(root, "MIGRATION.md"), "utf8").split("\n");
const linkRe = /\[`?tests\/migration\/([^\]`]+\.ts)`?\]\(tests\/migration\//;

type Block = { readonly line: number; readonly link: string | undefined; readonly body: string };
const blocks: Block[] = [];
let lastLink: { readonly line: number; readonly name: string } | undefined;
for (let i = 0; i < doc.length; i += 1) {
  const link = linkRe.exec(doc[i] ?? "");
  if (link !== null) {
    lastLink = { line: i + 1, name: link[1] ?? "" };
  }
  if (doc[i]?.trim() !== "```ts") {
    continue;
  }
  const lines: string[] = [];
  let end = -1;
  for (let j = i + 1; j < doc.length; j += 1) {
    if (doc[j]?.trim() === "```") {
      end = j;
      break;
    }
    lines.push(doc[j] ?? "");
  }
  if (end === -1) {
    console.log(`UNTERMINATED block starting line ${String(i + 1)}`);
    process.exit(1);
  }
  blocks.push({ line: i + 1, link: lastLink?.name, body: lines.join("\n") });
  i = end;
}

const referenced = new Set<string>();
let failures = 0;
for (const block of blocks) {
  if (block.link === undefined) {
    console.log(`MISMATCH line ${String(block.line)}: no tests/migration link before the block`);
    failures += 1;
    continue;
  }
  referenced.add(block.link);
  const path = resolve(root, "tests/migration", block.link);
  let file: string;
  try {
    file = readFileSync(path, "utf8");
  } catch {
    console.log(
      `MISSING  line ${String(block.line)}: tests/migration/${block.link} does not exist`,
    );
    failures += 1;
    continue;
  }
  if (block.body === file || `${block.body}\n` === file) {
    console.log(`MATCH    line ${String(block.line)}: tests/migration/${block.link}`);
  } else {
    failures += 1;
    console.log(`MISMATCH line ${String(block.line)}: tests/migration/${block.link}`);
    const docLines = block.body.split("\n");
    const fileLines = file.replace(/\n$/, "").split("\n");
    const width = Math.max(docLines.length, fileLines.length);
    for (let i = 0; i < width; i += 1) {
      if (docLines[i] !== fileLines[i]) {
        console.log(`   line ${String(i + 1)} doc: ${docLines[i] ?? "<absent>"}`);
        console.log(`   line ${String(i + 1)} src: ${fileLines[i] ?? "<absent>"}`);
      }
    }
  }
}
for (const name of readdirSync(resolve(root, "tests/migration")).filter((n) => n.endsWith(".ts"))) {
  if (!referenced.has(name)) {
    console.log(`UNREFERENCED: tests/migration/${name} has no fenced block`);
  }
}
console.log(
  `${String(blocks.length)} blocks checked, ${String(failures)} mismatch${failures === 1 ? "" : "es"}`,
);
process.exit(failures === 0 ? 0 : 1);
