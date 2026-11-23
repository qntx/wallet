/**
 * Drift check for the frozen card-protocol vectors (`vectors/card/`): `bun
 * scripts/check-card-vectors.ts <wallet-applet checkout>` proves the committed files are still the
 * applet's published `spec/vectors` at the commit `vectors/card/SOURCE` records — the applet
 * checkout's HEAD must equal that commit, every applet `spec/vectors/*.json` must byte-equal its
 * copy, no applet file may be missing and no copied file may be extra (`oracle.json` and `SOURCE`
 * are host-owned), and every SOURCE SHA-256 line must match the committed file. Without a checkout
 * the local half still runs: the SOURCE hashes and the listed-file set are checked.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CARD = "vectors/card";
/** Files in vectors/card/ the applet does not publish — host-owned, exempt from set equality. */
const HOST_OWNED = new Set(["SOURCE", "oracle.json"]);

export type Source = {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly licence: string;
  /** File name → recorded SHA-256. */
  readonly hashes: ReadonlyMap<string, string>;
};

type Head = {
  repository?: string;
  commit?: string;
  path?: string;
  licence?: string;
};

/** Parses the `key value` head lines and `<sha256> <file>` tail lines of a SOURCE file. */
export function parseSource(text: string): Source {
  const head: Head = {};
  const hashes = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [, sha, file] = /^([0-9a-f]{64}) {2}(.+)$/.exec(line) ?? [];
    if (sha !== undefined && file !== undefined) {
      hashes.set(file, sha);
      continue;
    }
    const [, key, value] = /^(repository|commit|path|licence) (.+)$/.exec(line) ?? [];
    if (key !== undefined && value !== undefined) {
      switch (key) {
        case "repository":
          head.repository = value;
          break;
        case "commit":
          head.commit = value;
          break;
        case "path":
          head.path = value;
          break;
        default:
          head.licence = value;
      }
      continue;
    }
    if (line.trim() !== "") {
      throw new Error(`unparsable SOURCE line: ${line}`);
    }
  }
  const { repository, commit, path, licence } = head;
  if (
    repository === undefined ||
    commit === undefined ||
    path === undefined ||
    licence === undefined
  ) {
    throw new Error("SOURCE is missing a repository/commit/path/licence line");
  }
  if (hashes.size === 0) {
    throw new Error("SOURCE lists no file hashes");
  }
  return { repository, commit, path, licence, hashes };
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

const jsonFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .toSorted()
    : [];

/** The checks that need no applet checkout: SOURCE integrity and the copied-file set. */
export function localViolations(root: string, source: Source): string[] {
  const violations: string[] = [];
  const dir = join(root, CARD);
  const copied = new Set(jsonFiles(dir).filter((name) => !HOST_OWNED.has(name)));
  for (const [file, want] of source.hashes) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      violations.push(`SOURCE lists ${file} but ${CARD}/${file} does not exist`);
      continue;
    }
    const got = sha256(new Uint8Array(readFileSync(path)));
    if (got !== want) {
      violations.push(`${CARD}/${file} SHA-256 ${got} ≠ SOURCE ${want}`);
    }
  }
  for (const file of copied) {
    if (!source.hashes.has(file)) {
      violations.push(`${CARD}/${file} is not listed in SOURCE`);
    }
  }
  for (const file of source.hashes.keys()) {
    if (!copied.has(file)) {
      violations.push(`SOURCE lists ${file} but it was not copied into ${CARD}/`);
    }
  }
  return violations;
}

/** The applet side: pinned commit plus byte equality with `spec/vectors/*.json`. */
export function remoteViolations(root: string, source: Source, checkout: string): string[] {
  const violations: string[] = [];
  let head: string;
  try {
    head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return [`cannot read the applet checkout HEAD: git -C ${checkout} rev-parse HEAD failed`];
  }
  if (head !== source.commit) {
    violations.push(`applet HEAD ${head} ≠ recorded commit ${source.commit}`);
  }
  const remoteDir = join(checkout, source.path);
  const remote = new Set(jsonFiles(remoteDir));
  if (remote.size === 0) {
    violations.push(`no *.json under ${checkout}/${source.path}`);
    return violations;
  }
  const copied = new Set(jsonFiles(join(root, CARD)).filter((name) => !HOST_OWNED.has(name)));
  for (const file of remote) {
    if (!copied.has(file)) {
      violations.push(`applet ${source.path}/${file} is missing from ${CARD}/`);
      continue;
    }
    const a = readFileSync(join(remoteDir, file));
    const b = readFileSync(join(root, CARD, file));
    if (!a.equals(b)) {
      violations.push(`${CARD}/${file} differs from ${checkout}/${source.path}/${file}`);
    }
  }
  for (const file of copied) {
    if (!remote.has(file)) {
      violations.push(`${CARD}/${file} has no counterpart under ${source.path}/`);
    }
  }
  return violations;
}

if (import.meta.main) {
  const { 2: checkout } = process.argv;
  if (checkout === undefined) {
    console.error("usage: bun scripts/check-card-vectors.ts <wallet-applet checkout>");
    process.exitCode = 1;
  } else {
    const source = parseSource(readFileSync(join(ROOT, CARD, "SOURCE"), "utf8"));
    const violations = [
      ...localViolations(ROOT, source),
      ...remoteViolations(ROOT, source, checkout),
    ];
    for (const violation of violations) {
      console.error(violation);
    }
    if (violations.length > 0) {
      console.error(`\ncheck-card-vectors: ${violations.length} violation(s)`);
      process.exitCode = 1;
    } else {
      console.log("check-card-vectors: vectors/card matches the applet at the recorded commit");
    }
  }
}
