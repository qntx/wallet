/// <reference types="node" />
/**
 * Check-toolchain pins the single source of the Bun version (the root `packageManager` field), the
 * shape of every setup-bun step in CI, and the exactness of bunfig's release-age exemptions. The
 * last test runs the real repo through every check — a regression that breaks one of these
 * invariants fails here before `bun run lint` does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { checkBunfig, checkManifest, checkWorkflow } from "./check-toolchain.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const STEP = "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0";

describe("checkWorkflow", () => {
  it("passes a step pinned at the root packageManager field", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      `${STEP}\n        with:\n          bun-version-file: package.json\n`,
    );
    expect(errors).toStrictEqual([]);
  });

  it("fails a step with no with: block", () => {
    const errors = checkWorkflow(".github/workflows/ci.yml", `${STEP}\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version-file: package.json");
  });

  it("fails a step that still carries bun-version", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      `${STEP}\n        with:\n          bun-version: 1.4.4\n          bun-version-file: package.json\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version");
  });

  it("fails a step pointing at another version file", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      `${STEP}\n        with:\n          bun-version-file: .bun-version\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version-file: package.json");
  });

  it("does not read the next step's with: block", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      `${STEP}\n      - uses: actions/setup-java@dd06d9cba3e5552c54d9f8ea23572deb30010f7c\n        with:\n          distribution: temurin\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version-file: package.json");
  });

  it("checks a step whose uses: sits on its own line under - name:", () => {
    const named = (withBlock: string): string =>
      `      - name: Setup Bun\n        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6\n${withBlock}`;
    expect(
      checkWorkflow(
        ".github/workflows/ci.yml",
        named("        with:\n          bun-version-file: package.json\n"),
      ),
    ).toStrictEqual([]);
    const errors = checkWorkflow(".github/workflows/ci.yml", named(""));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version-file: package.json");
  });

  it("fails a reference that is not a uses: line", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      `      - run: bun install # needs oven-sh/setup-bun@\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("uses:");
  });

  it("fails a uses: line that resolves to no step", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      `uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot resolve the step");
  });
});

describe("checkManifest", () => {
  it("passes a root manifest with a bun packageManager pin", () => {
    expect(checkManifest("package.json", { packageManager: "bun@1.4.4" }, true)).toStrictEqual([]);
  });

  it.each([
    ["missing", {}],
    ["not bun", { packageManager: "npm@11.0.0" }],
    ["a range", { packageManager: "bun@^1.4.4" }],
    ["two-part", { packageManager: "bun@1.4" }],
  ])("fails a root manifest whose packageManager is %s", (_name, manifest) => {
    const errors = checkManifest("package.json", manifest, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("packageManager");
  });

  it("fails any manifest keeping devEngines.packageManager", () => {
    const pkg = {
      devEngines: { packageManager: { name: "bun", version: "1.4.4" } },
    };
    expect(checkManifest("packages/wallet/package.json", pkg, false)).toHaveLength(1);
    expect(
      checkManifest("package.json", { ...pkg, packageManager: "bun@1.4.4" }, true),
    ).toHaveLength(1);
  });
});

describe("checkBunfig", () => {
  it("passes exact name@version entries", () => {
    const errors = checkBunfig(
      'minimumReleaseAgeExcludes = ["@qntx/fiat24@0.1.0", "@qntx/ur@4.1.0"]',
    );
    expect(errors).toStrictEqual([]);
  });

  it.each([
    ["a bare name", '"@qntx/fiat24"'],
    ["a range", '"@qntx/fiat24@^0.1.0"'],
    ["a two-part version", '"@qntx/fiat24@0.1"'],
    ["a tag", '"@qntx/fiat24@latest"'],
  ])("fails %s", (_name, entry) => {
    const errors = checkBunfig(`minimumReleaseAgeExcludes = [${entry}]`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("name@X.Y.Z");
  });
});

describe("the repository", () => {
  it("has no toolchain findings", () => {
    const errors = [
      ...checkWorkflow(
        ".github/workflows/ci.yml",
        readFileSync(`${ROOT}/.github/workflows/ci.yml`, "utf8"),
      ),
      ...checkManifest(
        "package.json",
        JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")),
        true,
      ),
      ...checkBunfig(readFileSync(`${ROOT}/bunfig.toml`, "utf8")),
    ];
    expect(errors).toStrictEqual([]);
  });
});
