/// <reference types="node" />
/**
 * One source of truth for the Bun toolchain version: the root package.json `packageManager` field.
 * Every `oven-sh/setup-bun` step in CI reads it via `bun-version-file: package.json` (a literal
 * `bun-version` would be a second, drifting source), `devEngines.packageManager` is gone for the
 * same reason, and `bunfig.toml`'s `minimumReleaseAgeExcludes` entries must be exact `name@X.Y.Z`
 * pins — a bare name exempts every future release of that package from the 7-day cooldown, not just
 * the one the PR meant to land early. Exit 1 with one line per finding.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const BUN_ACTION = /oven-sh\/setup-bun@/;
const VERSION_FILE = "package.json";
const PACKAGE_MANAGER = /^bun@\d+\.\d+\.\d+$/;
/** `name@X.Y.Z`, scoped names allowed — no ranges, no bare names, no tags. */
const EXACT_PIN = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@\d+\.\d+\.\d+$/;

type JsonObject = Record<string, unknown>;

const asRecord = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Every `- uses: oven-sh/setup-bun@…` step must carry `bun-version-file: package.json` in its
 * `with:` block and must not set `bun-version`. The workflows are plain YAML, so a step's `with:`
 * block is read by indentation: `with:` aligns with `uses:` under the dash, its entries sit one
 * level deeper, and the step ends at the next line no deeper than the dash.
 */
export function checkWorkflow(path: string, source: string): string[] {
  const errors: string[] = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)-\s+uses:\s+/.exec(line);
    if (match === null || !line.includes('oven-sh\/setup-bun@')) {
      continue;
    }
    const dash = match[1].length;
    const at = `${path}:${index + 1}`;
    let end = lines.length;
    for (let j = index + 1; j < lines.length; j++) {
      if (lines[j].trim() !== "" && indentOf(lines[j]) <= dash) {
        end = j;
        break;
      }
    }
    const step = lines.slice(index + 1, end);
    const usesIndent = dash + 2;
    const withIndex = step.findIndex((l) => indentOf(l) === usesIndent && l.trim() === "with:");
    const entries = new Map<string, string>();
    if (withIndex !== -1) {
      for (const l of step.slice(withIndex + 1)) {
        if (l.trim() !== "" && indentOf(l) <= usesIndent) {
          break;
        }
        const entry = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(l);
        if (entry !== null) {
          entries.set(entry[1], entry[2]);
        }
      }
    }
    if (entries.has("bun-version")) {
      errors.push(
        `${at}: setup-bun must not set bun-version — the version comes from ${VERSION_FILE}`,
      );
    }
    if (entries.get("bun-version-file") !== VERSION_FILE) {
      errors.push(`${at}: setup-bun must set bun-version-file: ${VERSION_FILE}`);
    }
  }
  return errors;
}

/**
 * The root manifest must pin `packageManager: "bun@<X.Y.Z>"`; no manifest — root included — may
 * keep a `devEngines.packageManager` declaration, which every tool but Bun reads differently and
 * which would drift against the field.
 */
export function checkManifest(path: string, pkg: unknown, root: boolean): string[] {
  const errors: string[] = [];
  const manifest = asRecord(pkg);
  if ("packageManager" in asRecord(manifest["devEngines"])) {
    errors.push(
      `${path}: devEngines.packageManager must not exist — the packageManager field is the only source`,
    );
  }
  if (
    root &&
    (typeof manifest["packageManager"] !== "string" ||
      !PACKAGE_MANAGER.test(manifest["packageManager"]))
  ) {
    errors.push(
      `${path}: packageManager must be "bun@<X.Y.Z>", got ${JSON.stringify(manifest["packageManager"])}`,
    );
  }
  return errors;
}

/**
 * `minimumReleaseAgeExcludes` entries must be exact `name@X.Y.Z` pins: a bare name exempts every
 * later release of that package from the 7-day cooldown forever, not just the version the PR needed
 * early.
 */
export function checkBunfig(source: string): string[] {
  const line = source
    .split("\n")
    .find((l) => l.trimStart().startsWith("minimumReleaseAgeExcludes"));
  if (line === undefined) {
    return [];
  }
  return [...line.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1])
    .filter((entry) => !EXACT_PIN.test(entry))
    .map(
      (entry) =>
        `bunfig.toml: minimumReleaseAgeExcludes entry ${JSON.stringify(entry)} must be an exact name@X.Y.Z pin`,
    );
}

/** Immediate subdirectories of `dir` that hold a package.json (`packages/*`, `apps/*`). */
const manifestPaths = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}/package.json`)
    .filter((path) => existsSync(join(ROOT, path)));

if (import.meta.main) {
  const errors: string[] = [];
  for (const file of readdirSync(join(ROOT, ".github/workflows")).toSorted()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) {
      continue;
    }
    const path = `.github/workflows/${file}`;
    errors.push(...checkWorkflow(path, readFileSync(join(ROOT, path), "utf8")));
  }
  const paths = ["package.json", ...manifestPaths("packages"), ...manifestPaths("apps")];
  for (const path of paths) {
    const pkg: unknown = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    errors.push(...checkManifest(path, pkg, path === "package.json"));
  }
  errors.push(...checkBunfig(readFileSync(join(ROOT, "bunfig.toml"), "utf8")));
  for (const error of errors) {
    console.error(`check-toolchain: ${error}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
