/// <reference types="node" />
/**
 * MIGRATION.md §13 completeness: every export a published entry point had in the last release and
 * no longer has must be named (in backticks) in "## 13. Removed APIs". The released surface comes
 * from the registry — `npm pack @qntx/<pkg>@<version>` — run through the same API Extractor report
 * as `check:pkg` (scripts/check-api.ts), and is compared with each package's committed `api/`
 * reports. Needs network access, so it runs by hand before a release, not in `lint`:
 *
 * Bun scripts/check-migration.ts [version] # default: the newest vX.Y.Z tag
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const DECLARATION =
  /^export (?:declare )?(?:abstract )?(?:function|const|let|var|type|interface|class|enum|namespace) ([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export \{([^}]*)\}/gm;

/** The names an API Extractor report exports — declarations and `export { … }` lists. */
export function exportedNames(report: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of report.matchAll(DECLARATION)) {
    names.add(match[1] ?? "");
  }
  for (const match of report.matchAll(EXPORT_LIST)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name =
        part
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? "";
      if (name !== "") {
        names.add(name);
      }
    }
  }
  names.delete("");
  return names;
}

/** The text of `## 13. Removed APIs` up to the next `## ` heading. */
export function removedSection(migration: string): string {
  const start = migration.indexOf("\n## 13. Removed APIs");
  if (start === -1) {
    throw new Error("MIGRATION.md has no `## 13. Removed APIs` section");
  }
  const end = migration.indexOf("\n## ", start + 1);
  return migration.slice(start, end === -1 ? undefined : end);
}

/** Every backticked span of `text`, split into its identifier-like words. */
export function namedIn(text: string): ReadonlySet<string> {
  const words = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    for (const word of (match[1] ?? "").split(/[^\w$]+/)) {
      if (word !== "") {
        words.add(word);
      }
    }
  }
  return words;
}

type Removed = { readonly pkg: string; readonly entry: string; readonly name: string };

/** Exports present in a `before` report and absent from the `after` report of the same entry. */
export function removedExports(
  pkg: string,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Removed[] {
  return [...before].flatMap(([entry, report]) => {
    const now = exportedNames(after.get(entry) ?? "");
    return [...exportedNames(report)]
      .filter((name) => !now.has(name))
      .toSorted()
      .map((name) => ({ pkg, entry, name }));
  });
}

const reportsIn = (dir: string): Map<string, string> =>
  new Map(
    existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.endsWith(".api.md"))
          .map((file) => [file.replace(/\.api\.md$/, ""), readFileSync(join(dir, file), "utf8")])
      : [],
  );

const latestTag = (): string => {
  const tags = execFileSync("git", ["tag", "--list", "v*.*.*", "--sort=-v:refname"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const tag = tags.split("\n").find((line) => /^v\d+\.\d+\.\d+$/.test(line));
  if (tag === undefined) {
    throw new Error("no vX.Y.Z tag to compare against");
  }
  return tag.slice(1);
};

/** Published package directories: packages/* whose package.json is not private. */
const publishedPackages = (): Array<{ readonly name: string; readonly dir: string }> =>
  readdirSync(join(ROOT, "packages")).flatMap((entry) => {
    const manifest = join(ROOT, "packages", entry, "package.json");
    if (!existsSync(manifest)) {
      return [];
    }
    const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof pkg !== "object" || pkg === null || !("name" in pkg)) {
      return [];
    }
    const isPrivate = "private" in pkg && pkg.private === true;
    return typeof pkg.name === "string" && !isPrivate
      ? [{ name: pkg.name, dir: join(ROOT, "packages", entry) }]
      : [];
  });

if (import.meta.main) {
  const version = process.argv[2] ?? latestTag();
  const temp = mkdtempSync(join(tmpdir(), "check-migration-"));
  const removed: Removed[] = [];
  try {
    for (const { name, dir } of publishedPackages()) {
      const tarball = execFileSync(
        "npm",
        ["pack", `${name}@${version}`, "--pack-destination", temp, "--silent"],
        { encoding: "utf8" },
      ).trim();
      const unpacked = join(temp, name.replace("/", "__"));
      execFileSync("mkdir", ["-p", unpacked]);
      execFileSync("tar", ["-xzf", join(temp, tarball), "-C", unpacked, "--strip-components=1"]);
      execFileSync("bun", [join(ROOT, "scripts/check-api.ts"), unpacked, "--update"], {
        stdio: "ignore",
      });
      removed.push(
        ...removedExports(name, reportsIn(join(unpacked, "api")), reportsIn(join(dir, "api"))),
      );
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const named = namedIn(removedSection(readFileSync(join(ROOT, "MIGRATION.md"), "utf8")));
  let missing = 0;
  for (const { pkg, entry, name } of removed) {
    const listed = named.has(name);
    if (!listed) {
      missing += 1;
    }
    console.log(`${listed ? "listed " : "MISSING"}  ${pkg} ${entry}  ${name}`);
  }
  console.log(
    `\ncheck-migration: ${removed.length} export(s) removed since ${version}, ${missing} not in §13`,
  );
  if (missing > 0) {
    process.exitCode = 1;
  }
}
