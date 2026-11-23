/**
 * Build the pinned Ledger apps (scripts/ledger/apps.json) into speculos-loadable ELFs under
 * .cache/ledger/elf/<app>.elf.
 *
 * Each app is shallow-cloned at its pinned commit and built inside the pinned
 * ledger-app-builder-lite image against a ledger-secure-sdk clone at the pinned tag
 * (BOLOS_SDK=<clone>, TARGET=nanos2 — Nano S+). The build is idempotent: an app is skipped when its
 * ELF exists and .cache/ledger/build.json records the same commit+sdk+image.
 *
 * The builder image is multi-arch: it runs natively on both arm64 (local) and amd64 (CI).
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pins from "./apps.json" with { type: "json" };

const root = fileURLToPath(new URL("../..", import.meta.url));
const cache = resolve(root, ".cache/ledger");
const srcDir = resolve(cache, "src");
const sdkDir = resolve(cache, "sdk");
const elfDir = resolve(cache, "elf");
const buildJsonPath = resolve(cache, "build.json");

const builderImage = pins.images.builder;

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): void {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${String(result.status)}`);
  }
}

function capture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${String(result.status)}`);
  }
  return result.stdout.toString().trim();
}

/**
 * Shallow-clone `tag` of `repo` into `dir` and verify HEAD is `commit`. Existing checkouts are
 * reused only when HEAD already matches; anything else is replaced so a stale or moved tag can
 * never slip in silently.
 */
function ensureClone(
  dir: string,
  repo: string,
  tag: string,
  commit: string,
  submodules: string[] = [],
): void {
  const fetchSubmodules = (): void => {
    // Submodule commits are pinned by the parent tree; only the paths the build needs are
    // fetched (some repos list docs-only submodules on SSH URLs that are not routable).
    if (submodules.length === 0) {
      return;
    }
    run("git", [
      "-c",
      "http.version=HTTP/1.1",
      "-c",
      "url.https://github.com/.insteadOf=git@github.com:",
      "-C",
      dir,
      "submodule",
      "update",
      "--init",
      "--depth",
      "1",
      "--",
      ...submodules,
    ]);
  };
  if (existsSync(resolve(dir, ".git"))) {
    const head = capture("git", ["-C", dir, "rev-parse", "HEAD"]);
    if (head === commit) {
      fetchSubmodules();
      return;
    }
    console.log(`${dir}: HEAD ${head} != pinned ${commit}, re-cloning`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // HTTP/1.1: the smart-HTTP transfer truncates under HTTP/2 through some proxies.
      run("git", [
        "-c",
        "http.version=HTTP/1.1",
        "clone",
        "--depth",
        "1",
        "--branch",
        tag,
        `https://github.com/${repo}.git`,
        dir,
      ]);
      const head = capture("git", ["-C", dir, "rev-parse", "HEAD"]);
      if (head !== commit) {
        throw new Error(`${repo}@${tag}: cloned HEAD ${head} != pinned commit ${commit}`);
      }
      fetchSubmodules();
      return;
    } catch (error) {
      lastError = error;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw lastError;
}

type BuildRecord = {
  commit: string;
  sdk: string;
  sdkCommit: string;
  image: string;
  seconds: number;
  builtAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuildRecord(value: unknown): value is BuildRecord {
  return (
    isRecord(value) &&
    typeof value["commit"] === "string" &&
    typeof value["sdk"] === "string" &&
    typeof value["sdkCommit"] === "string" &&
    typeof value["image"] === "string" &&
    typeof value["seconds"] === "number" &&
    typeof value["builtAt"] === "string"
  );
}

function loadBuildJson(): Record<string, BuildRecord> {
  if (!existsSync(buildJsonPath)) {
    return {};
  }
  const raw: unknown = JSON.parse(readFileSync(buildJsonPath, "utf8"));
  if (!isRecord(raw)) {
    return {};
  }
  const records: Record<string, BuildRecord> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isBuildRecord(value)) {
      records[key] = value;
    }
  }
  return records;
}

mkdirSync(srcDir, { recursive: true });
mkdirSync(sdkDir, { recursive: true });
mkdirSync(elfDir, { recursive: true });

const records = loadBuildJson();
for (const [key, app] of Object.entries(pins.apps)) {
  const elf = resolve(elfDir, `${key}.elf`);
  const prev = records[key];
  if (
    existsSync(elf) &&
    prev?.commit === app.commit &&
    prev.sdk === app.sdk &&
    prev.sdkCommit === app.sdkCommit &&
    prev.image === builderImage
  ) {
    console.log(`${key}: up to date, skipping`);
    continue;
  }

  ensureClone(resolve(srcDir, key), app.repo, app.tag, app.commit, app.submodules);
  // SDK is pinned by commit (sdkCommit) like the apps; cloned lazily so a cache hit on the
  // ELFs does no network work at all.
  ensureClone(resolve(sdkDir, app.sdk), "LedgerHQ/ledger-secure-sdk", app.sdk, app.sdkCommit);

  const started = Date.now();
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${cache}:/work`,
    "-w",
    `/work/src/${key}`,
    "-e",
    `BOLOS_SDK=/work/sdk/${app.sdk}`,
    builderImage,
    "make",
    "-j",
    `TARGET=${pins.target}`,
    ...app.make,
  ]);
  const seconds = Math.round((Date.now() - started) / 1000);

  const built = resolve(srcDir, key, "build", pins.target, "bin", "app.elf");
  if (!existsSync(built)) {
    throw new Error(`${key}: expected ELF missing at ${built}`);
  }
  copyFileSync(built, elf);

  records[key] = {
    commit: app.commit,
    sdk: app.sdk,
    sdkCommit: app.sdkCommit,
    image: builderImage,
    seconds,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(buildJsonPath, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`${key}: built in ${String(seconds)}s -> ${elf}`);
}
