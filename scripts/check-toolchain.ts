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
const BUN_ACTION = "oven-sh/setup-bun@";
const VERSION_FILE = "package.json";
const PACKAGE_MANAGER = /^bun@\d+\.\d+\.\d+$/;
/** `name@X.Y.Z`, scoped names allowed — no ranges, no bare names, no tags. */
const EXACT_PIN = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@\d+\.\d+\.\d+$/;

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonObject => (isRecord(value) ? value : {});

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Every step that references `oven-sh/setup-bun@…` must carry `bun-version-file: package.json` in
 * its `with:` block and must not set `bun-version`. The reference may sit on the step's dash line
 * (`- uses: …`) or on its own line under another key (`- name: Setup Bun` then `uses: …`), so the
 * step's extent is resolved from its dash line — the reference line itself when it carries the
 * dash, else the nearest preceding `- ` line no deeper than the `uses:` key — and a reference that
 * does not resolve to a step is itself a finding. The step's `with:` block is then read by
 * indentation: `with:` aligns with `uses:`, its entries sit one level deeper, and the step ends at
 * the next line no deeper than the dash.
 */
export function checkWorkflow(path: string, source: string): string[] {
  const errors: string[] = [];
  const lines = source.split("\n");
  const dashLine = /^(\s*)-\s+/;
  for (const [index, line] of lines.entries()) {
    if (!line.includes(BUN_ACTION)) {
      continue;
    }
    const at = `${path}:${index + 1}`;
    const usesColumn = line.indexOf("uses:");
    if (usesColumn === -1 || !/^uses:\s*oven-sh\/setup-bun@/.test(line.slice(usesColumn))) {
      errors.push(`${at}: a setup-bun reference must be a step's uses: line`);
      continue;
    }
    const own = dashLine.exec(line);
    let dash: number | undefined;
    if (own === null) {
      for (let j = index - 1; j >= 0; j--) {
        const l = lines[j];
        if (l === undefined || l.trim() === "") {
          continue;
        }
        const above = dashLine.exec(l);
        if (above !== null && (above[1] ?? "").length <= usesColumn) {
          dash = (above[1] ?? "").length;
          break;
        }
      }
    } else {
      dash = (own[1] ?? "").length;
    }
    if (dash === undefined) {
      errors.push(`${at}: cannot resolve the step holding this setup-bun reference`);
      continue;
    }
    let end = lines.length;
    for (let j = index + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l !== undefined && l.trim() !== "" && indentOf(l) <= dash) {
        end = j;
        break;
      }
    }
    const step = lines.slice(index + 1, end);
    const withIndex = step.findIndex((l) => indentOf(l) === usesColumn && l.trim() === "with:");
    const entries = new Map<string, string>();
    if (withIndex !== -1) {
      for (const l of step.slice(withIndex + 1)) {
        if (l.trim() !== "" && indentOf(l) <= usesColumn) {
          break;
        }
        const entry = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(l);
        if (entry !== null) {
          entries.set(entry[1] ?? "", entry[2] ?? "");
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
    .map((match) => match[1] ?? "")
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
  const workflowFiles = (dir: string): string[] =>
    existsSync(join(ROOT, dir))
      ? readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
          if (entry.isDirectory()) {
            return workflowFiles(`${dir}/${entry.name}`);
          }
          const yml = entry.name.endsWith(".yml") || entry.name.endsWith(".yaml");
          return yml && (dir.endsWith("workflows") || dir.includes("/actions/"))
            ? [`${dir}/${entry.name}`]
            : [];
        })
      : [];
  for (const path of workflowFiles(".github").toSorted()) {
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
