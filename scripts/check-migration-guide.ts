/// <reference types="node" />
/**
 * MIGRATION.md self-consistency — offline, runs in `lint`:
 *
 * - A ```ts block directly under a `[tests/migration/<file>](...):` link line (one blank line
 *   between) must equal the file's content, trailing newline ignored. `--update` rewrites stale
 *   blocks from the files instead of failing.
 * - Every `tests/migration/*.ts` file must be referenced somewhere in MIGRATION.md, and every
 *   `tests/migration/<file>` reference must name a file that exists.
 * - Every `§<n>` reference in MIGRATION.md, in `tests/migration/*.ts` and in CHANGELOG.md's release
 *   entry (the first non-empty entry under `## [`) must name a `## <n>.` heading in MIGRATION.md.
 *   `§` followed by a non-digit is ignored.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SNIPPETS = join("tests", "migration");

const LINK_LINE = /^\[`tests\/migration\/([\w.-]+\.ts)`\]\([^)]*\):[ \t]*$/gm;
const FILE_REF = /tests\/migration\/([\w.-]+\.ts)/g;
const HEADING = /^## (\d+)\./gm;
const SECTION_REF = /§(\d+)/g;
const BLOCK_PREFIX = "\n\n```ts\n";

type EmbeddedBlock = {
  readonly file: string;
  readonly content: string;
  readonly start: number;
  readonly end: number;
};

/** The ```ts blocks sitting directly under a `tests/migration/<file>` link line. */
export function embeddedBlocks(migration: string): EmbeddedBlock[] {
  const blocks: EmbeddedBlock[] = [];
  for (const match of migration.matchAll(LINK_LINE)) {
    const after = match.index + match[0].length;
    if (!migration.startsWith(BLOCK_PREFIX, after)) {
      continue;
    }
    const start = after + BLOCK_PREFIX.length;
    const end = migration.indexOf("\n```", start);
    if (end === -1) {
      continue;
    }
    blocks.push({ file: match[1] ?? "", content: migration.slice(start, end), start, end });
  }
  return blocks;
}

const canonical = (text: string): string => text.replace(/\n+$/, "");

/**
 * Blocks whose embedded text differs from the file. With `update` the migration text is returned
 * rewritten instead (`updated` lists the files whose blocks were rewritten).
 */
export function checkBlocks(
  migration: string,
  read: (file: string) => string | undefined,
  update: boolean,
): { readonly migration: string; readonly findings: string[]; readonly updated: string[] } {
  const findings: string[] = [];
  const updated: string[] = [];
  let text = migration;
  for (const block of embeddedBlocks(migration).toReversed()) {
    const file = read(block.file);
    if (file === undefined) {
      findings.push(`MIGRATION.md: link names tests/migration/${block.file}, which does not exist`);
      continue;
    }
    if (block.content === canonical(file)) {
      continue;
    }
    if (!update) {
      findings.push(`MIGRATION.md: embedded block for tests/migration/${block.file} is stale`);
      continue;
    }
    text = text.slice(0, block.start) + canonical(file) + text.slice(block.end);
    updated.unshift(block.file);
  }
  return { migration: text, findings, updated };
}

/** Findings for unreferenced snippet files and references to files that do not exist. */
export function checkFileRefs(migration: string, files: ReadonlyArray<string>): string[] {
  const findings: string[] = [];
  const known = new Set(files);
  const referenced = new Set<string>();
  const missing = new Set<string>();
  for (const match of migration.matchAll(FILE_REF)) {
    const file = match[1] ?? "";
    referenced.add(file);
    if (!known.has(file) && !missing.has(file)) {
      missing.add(file);
      findings.push(`MIGRATION.md: references tests/migration/${file}, which does not exist`);
    }
  }
  for (const file of files) {
    if (!referenced.has(file)) {
      findings.push(`MIGRATION.md: tests/migration/${file} is not referenced`);
    }
  }
  return findings;
}

/** The section numbers `## <n>.` of the guide. */
export function sectionHeadings(migration: string): ReadonlySet<number> {
  const headings = new Set<number>();
  for (const match of migration.matchAll(HEADING)) {
    headings.add(Number(match[1]));
  }
  return headings;
}

/** `§<n>` references in `text` that name no heading, reported as `source` lines. */
export function checkSectionRefs(
  source: string,
  text: string,
  headings: ReadonlySet<number>,
): string[] {
  const findings: string[] = [];
  const seen = new Set<number>();
  for (const match of text.matchAll(SECTION_REF)) {
    const section = Number(match[1]);
    if (!headings.has(section) && !seen.has(section)) {
      seen.add(section);
      findings.push(`${source}: §${section} names no \`## ${section}.\` heading in MIGRATION.md`);
    }
  }
  return findings;
}

/**
 * The CHANGELOG.md entry the release notes are written into: `## [Unreleased]` when it carries any
 * non-blank line, otherwise the first versioned entry — up to the next `## [` either way.
 */
export function releaseEntry(changelog: string): string {
  const headings = [...changelog.matchAll(/^## \[/gm)];
  for (const [index, heading] of headings.entries()) {
    const start = heading.index;
    const next = headings[index + 1];
    const end = next === undefined ? undefined : next.index - 1;
    const entry = changelog.slice(start, end);
    const newline = entry.indexOf("\n");
    const body = newline === -1 ? "" : entry.slice(newline + 1);
    if (entry.startsWith("## [Unreleased]") && body.trim() === "") {
      continue;
    }
    return entry;
  }
  return "";
}

export function checkMigrationGuide(input: {
  readonly migration: string;
  readonly changelog: string;
  readonly files: ReadonlyArray<string>;
  readonly read: (file: string) => string | undefined;
}): string[] {
  const { migration, changelog, files, read } = input;
  const headings = sectionHeadings(migration);
  const findings = [
    ...checkBlocks(migration, read, false).findings,
    ...checkFileRefs(migration, files),
    ...checkSectionRefs("MIGRATION.md", migration, headings),
    ...checkSectionRefs("CHANGELOG.md", releaseEntry(changelog), headings),
  ];
  for (const file of files) {
    findings.push(...checkSectionRefs(`tests/migration/${file}`, read(file) ?? "", headings));
  }
  return findings;
}

if (import.meta.main) {
  const update = process.argv.includes("--update");
  const files = readdirSync(join(ROOT, SNIPPETS)).filter((file) => file.endsWith(".ts"));
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(join(ROOT, SNIPPETS, file), "utf8");
    } catch {
      return undefined;
    }
  };
  let migration = readFileSync(join(ROOT, "MIGRATION.md"), "utf8");
  if (update) {
    const { migration: rewritten, updated } = checkBlocks(migration, read, true);
    if (updated.length > 0) {
      writeFileSync(join(ROOT, "MIGRATION.md"), rewritten);
      migration = rewritten;
      for (const file of updated) {
        console.log(`check-migration-guide: rewrote the tests/migration/${file} block`);
      }
    }
  }
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const findings = checkMigrationGuide({ migration, changelog, files, read });
  for (const finding of findings) {
    console.error(`check-migration-guide: ${finding}`);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  }
}
