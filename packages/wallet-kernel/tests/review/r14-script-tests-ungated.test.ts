/// <reference types="node" />
/**
 * Review PoC R14-02: the root vitest project (`vite.config.ts` `test.include:
 * ["scripts/**\/*.test.ts"]`) holds the tests of every supply-chain and release gate script —
 * check-toolchain, check-dist-deps, check-security-anchors, check-version, check-migration(-guide),
 * check-boundaries, check-card-vectors, check-hermes-flags, readme-blocks — but nothing runs it:
 * `bun run test` / `test:coverage` recurse into workspace packages only (`vp run -r`), the root is
 * not a workspace package, and no workflow runs `vp test` at the repository root. A regression in
 * any of those scripts that makes it more permissive stays green everywhere, because the real tree
 * already satisfies the weakened rule. These tests assert today's wiring.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const ROOT = join(import.meta.dirname, "../../../..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

type Manifest = { scripts: Record<string, string>; workspaces: string[] };
const manifest = JSON.parse(read("package.json")) as Manifest;

const WORKFLOWS = join(ROOT, ".github/workflows");
const workflowTexts = (): string[] =>
  readdirSync(WORKFLOWS).map((file) => readFileSync(join(WORKFLOWS, file), "utf8"));
/** Each `- run: … vp test …` line with the step keys indented under it. */
const singleLineVpTestSteps = (): string[] =>
  workflowTexts().flatMap((text) =>
    [...text.matchAll(/^( *)- run:[^\n]*\bvp test\b[^\n]*\n(?:\1  [^\n]*\n)*/gm)].map((m) => m[0]),
  );

describe("root script tests exist but no gate runs them", () => {
  it("the root vitest project is the only one that includes scripts/**/*.test.ts", () => {
    expect(read("vite.config.ts")).toContain('include: ["scripts/**/*.test.ts"]');
    const files = readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".test.ts"));
    expect(files).toStrictEqual(
      expect.arrayContaining([
        "check-toolchain.test.ts",
        "check-dist-deps.test.ts",
        "check-security-anchors.test.ts",
      ]),
    );
  });

  it.each(["test", "test:coverage"])("bun run %s only recurses into workspace packages", (name) => {
    const script = manifest.scripts[name];
    expect(script).toMatch(/vp run --concurrency-limit 1 -r test/);
    // No root-level `vp test` (which is what runs scripts/**/*.test.ts).
    expect(script?.replaceAll(/vp run[^&]*/g, "")).not.toMatch(/\bvp test\b/);
    // The root is not a workspace of itself.
    expect(manifest.workspaces).not.toContain(".");
  });

  it("lint runs check-toolchain against the real tree, never its tests", () => {
    const { lint } = manifest.scripts;
    expect(lint).toContain("bun scripts/check-toolchain.ts");
    expect(lint).not.toMatch(/\bvp test\b/);
  });

  it("no workflow runs vitest at the repository root", () => {
    const rootRuns = workflowTexts().filter((text) => text.includes("run: bunx vp test scripts"));
    expect(rootRuns).toStrictEqual([]);
    // Every single-line `vp test` step names a package working-directory.
    expect(
      singleLineVpTestSteps().every((step) => step.includes("working-directory: packages/")),
    ).toBe(true);
  });
});
