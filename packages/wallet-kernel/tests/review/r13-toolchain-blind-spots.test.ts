/**
 * Review PoC R13-02: check-toolchain has two blind spots that let the CI Bun toolchain drift off
 * the root `packageManager: "bun@X.Y.Z"` pin it exists to defend. (a) `checkWorkflow` only audits
 * steps that literally `uses: oven-sh/setup-bun@`; .github/workflows/hermes.yml instead delegates
 * to the reusable workflow `qntx/workflows/.github/workflows/ci-hermes.yml@b1a930e…` and passes
 * no `bun-version`, so the reusable default `'1.4'` — the latest 1.4.x, verified against the
 * workflow source and a live run's `Inputs` log (CI run 45736633095, job 139631339122:
 * `bun-version: 1.4`) — selects the toolchain with no checkWorkflow finding at all. (b) ci.yml
 * and onekey.yml run `bunx vitest` inside packages that declare no `vitest` dependency (bunx
 * resolves the registry's latest at run time), and the script has no rule about `bunx`. These
 * tests assert today's blind spots as static facts so they pass now and fail once the check
 * covers them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { checkWorkflow } from "../../../../scripts/check-toolchain.ts";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/, "");
const read = (rel: string): string => readFileSync(`${ROOT}/${rel}`, "utf8");

const pkgDeclares = (rel: string, dep: string): boolean => {
  const pkg = JSON.parse(read(rel)) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return (
    dep in (pkg.dependencies ?? {}) ||
    dep in (pkg.devDependencies ?? {}) ||
    dep in (pkg.peerDependencies ?? {})
  );
};

describe("check-toolchain blind spot: reusable workflows bypass the Bun pin", () => {
  const source = read(".github/workflows/hermes.yml");

  it("hermes.yml delegates to the reusable workflow and passes no bun-version", () => {
    expect(source).toContain(
      "uses: qntx/workflows/.github/workflows/ci-hermes.yml@b1a930e790044f34f06bd5e1e0ede9e7dd5fa122",
    );
    expect(source).not.toContain("bun-version");
    expect(source).not.toContain("oven-sh/setup-bun@");
  });

  it("checkWorkflow returns no findings — the reusable default '1.4' is invisible to it", () => {
    /* The reusable workflow's own setup-bun step runs `bun-version: ${{ inputs.bun-version }}`
       with input default '1.4' — a floating toolchain the packageManager pin never selected. */
    expect(checkWorkflow(".github/workflows/hermes.yml", source)).toStrictEqual([]);
  });
});

describe("check-toolchain blind spot: bunx vitest resolves an undeclared toolchain", () => {
  it("ci.yml runs `bunx vitest` inside packages/wallet-engine", () => {
    const block = read(".github/workflows/ci.yml").split("\n");
    const idx = block.findIndex((line) => line.includes("bunx vitest"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(block.slice(idx, idx + 4).join("\n")).toContain(
      "working-directory: packages/wallet-engine",
    );
  });

  it("onekey.yml runs `bunx vitest` inside packages/wallet-kernel and packages/wallet-engine", () => {
    const source = read(".github/workflows/onekey.yml");
    expect(source).toContain("bunx vitest run tests/onekey-*.test.ts");
    expect(source).toContain("working-directory: packages/wallet-kernel");
    expect(source).toContain("working-directory: packages/wallet-engine");
  });

  it("neither package manifest nor the root declares vitest — bunx fetches it unpinned", () => {
    expect(pkgDeclares("packages/wallet-engine/package.json", "vitest")).toBe(false);
    expect(pkgDeclares("packages/wallet-kernel/package.json", "vitest")).toBe(false);
    expect(pkgDeclares("package.json", "vitest")).toBe(false);
  });

  it("check-toolchain has no rule about bunx", () => {
    const source = read("scripts/check-toolchain.ts");
    expect(source).not.toContain("bunx");
  });
});
