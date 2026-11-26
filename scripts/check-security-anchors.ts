/// <reference types="node" />
/**
 * SECURITY.md anchors — offline, runs in `lint`:
 *
 * - No `path.ts:<digits>` anchor anywhere: source locations are cited by symbol, never by line
 *   number, so a refactor cannot silently stale them.
 * - Every backticked repo-relative path (`foo/bar.ts`) must name a file or directory that exists.
 * - Every `path` + `symbol` pair must hold: symbols cited for a file — `` `file.ts` `sym1`/`sym2` ``
 *   or `` `sym1`/`sym2` in `file.ts` `` — are looked up as identifiers in that file's source.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** `file.ext:123` — the banned line-number form. */
const LINE_ANCHOR = /[\w./-]+\.[a-zA-Z]+:\d+/g;
const BACKTICK = /`([^`\n]+)`/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export type Anchor = { readonly path: string; readonly symbols: string[] };

/**
 * True when a backticked span reads as a repo-relative path, not a symbol or a package specifier
 * (`@qntx/...`).
 */
const SOURCE_SUFFIX = /\.(ts|tsx|mts|cts|js|mjs|mm|kt|c|cc|cpp|h|hpp|json|ya?ml|toml|swift|java)$/;

export const isPathSpan = (span: string): boolean =>
  (span.includes("/") || SOURCE_SUFFIX.test(span)) && !span.startsWith("@");

const spans = (md: string): Array<{ text: string; index: number }> =>
  [...md.matchAll(BACKTICK)].map((m) => ({ text: m[1] ?? "", index: m.index ?? 0 }));

/**
 * Symbol groups attached to a path: `` `path` `a`/`b` `` and `` `a`/`b` in `path` ``. A span
 * matches `in` + path (pattern A) or is itself a path followed by symbol spans (pattern B).
 */
export function anchors(md: string): Anchor[] {
  const list = spans(md);
  const found: Anchor[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const span = list[i];
    if (!span) {
      continue;
    }
    if (isPathSpan(span.text)) {
      const symbols: string[] = [];
      const between = (a: number, b: number): string => md.slice(a, b);
      let cursor = span.index + span.text.length + 2;
      for (let j = i + 1; j < list.length; j += 1) {
        const next = list[j];
        if (!next) {
          break;
        }
        const gap = between(cursor, next.index);
        if (!/^[\s/]*$/.test(gap)) {
          break;
        }
        if (!IDENTIFIER.test(next.text)) {
          break;
        }
        symbols.push(next.text);
        cursor = next.index + next.text.length + 2;
      }
      found.push({ path: span.text, symbols });
      continue;
    }
    if (IDENTIFIER.test(span.text)) {
      const group: string[] = [span.text];
      let cursor = span.index + span.text.length + 2;
      let j = i + 1;
      while (j < list.length) {
        const next = list[j];
        if (!next) {
          break;
        }
        const gap = md.slice(cursor, next.index);
        if (gap === "/") {
          if (!IDENTIFIER.test(next.text)) {
            break;
          }
          group.push(next.text);
          cursor = next.index + next.text.length + 2;
          j += 1;
          continue;
        }
        if (/^\s*in\s*$/.test(gap) && isPathSpan(next.text)) {
          found.push({ path: next.text, symbols: group });
        }
        break;
      }
    }
  }
  return found;
}

export function check(md: string, root: string = ROOT): string[] {
  const failures: string[] = [];
  for (const match of md.matchAll(LINE_ANCHOR)) {
    failures.push(`line-number anchor "${match[0]}" — cite the symbol instead`);
  }
  for (const anchor of anchors(md)) {
    const file = join(root, anchor.path.replace(/\/$/, ""));
    if (!existsSync(file)) {
      failures.push(`"${anchor.path}" does not exist`);
      continue;
    }
    if (anchor.symbols.length === 0 || !statSync(file).isFile()) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const symbol of anchor.symbols) {
      if (!new RegExp(`\\b${symbol.replaceAll("$", String.raw`\$`)}\\b`).test(source)) {
        failures.push(`"${anchor.path}" has no identifier \`${symbol}\``);
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const md = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
  const failures = check(md);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`SECURITY.md: ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`SECURITY.md: ${anchors(md).length} path anchors verified`);
  }
}
