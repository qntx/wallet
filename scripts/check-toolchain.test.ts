/// <reference types="node" />
/**
 * Check-toolchain pins the single source of the Bun version (the root `packageManager` field), the
 * shape of every setup-bun step in CI, the reusable-workflow toolchain handoff, exact Node pins,
 * the rule that every bunx/npx bin comes from a declared dependency, and the exactness of bunfig's
 * release-age exemptions. The last test runs the real repo through every check — a regression that
 * breaks one of these invariants fails here before `bun run lint` does.
 */
import { describe, expect, it } from "vite-plus/test";

import { checkBunfig, checkManifest, checkRepository, checkWorkflow } from "./check-toolchain.ts";
import type { DependencyIndex } from "./check-toolchain.ts";

/** The bins the fixture manifests offer: vp from vite-plus, wrangler, playwright, expo. */
const BINS: Record<string, string> = {
  vp: "vite-plus",
  wrangler: "wrangler",
  playwright: "@playwright/test",
  expo: "expo",
};
const DECLARED = new Set(Object.values(BINS));

const index: DependencyIndex = {
  bin: (name) => BINS[name],
  declared: (name) => DECLARED.has(name),
};

const stepsJob = (steps: string): string => `jobs:\n  t:\n    steps:\n${steps}`;

const isGateway = (dirs: ReadonlyArray<string>): boolean =>
  dirs.some((d) => d.endsWith("apps/gateway"));

/** A fixture index where only apps/gateway's manifest declares wrangler. */
const scopedIndex = (): DependencyIndex => ({
  bin: (name, dirs) => {
    if (name === "wrangler") {
      return isGateway(dirs) ? "wrangler" : undefined;
    }
    return BINS[name];
  },
  declared: (name, dirs) => DECLARED.has(name) || (name === "wrangler" && isGateway(dirs)),
});

/** The same scope, declared through a job-level defaults.run.working-directory. */
const defaultsIndex = (): DependencyIndex => ({
  bin: (name, dirs) => (name === "wrangler" && isGateway(dirs) ? "wrangler" : undefined),
  declared: (name, dirs) => name === "wrangler" && isGateway(dirs),
});

const SETUP_BUN =
  "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0";

describe("checkWorkflow setup-bun", () => {
  it("passes a step pinned at the root packageManager field", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(`${SETUP_BUN}\n        with:\n          bun-version-file: package.json\n`),
      index,
    );
    expect(errors).toStrictEqual([]);
  });

  it("fails a step with no with: block", () => {
    const errors = checkWorkflow(".github/workflows/ci.yml", stepsJob(`${SETUP_BUN}\n`), index);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version-file: package.json");
  });

  it("fails a step that still carries bun-version", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(
        `${SETUP_BUN}\n        with:\n          bun-version: 1.4.4\n          bun-version-file: package.json\n`,
      ),
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version");
  });

  it("fails a step pointing at another version file", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(`${SETUP_BUN}\n        with:\n          bun-version-file: .bun-version\n`),
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version-file: package.json");
  });

  it("does not read the next step's with: block", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(
        `${SETUP_BUN}\n      - uses: actions/setup-java@dd06d9cba3e5552c54d9f8ea23572deb30010f7c\n        with:\n          distribution: temurin\n`,
      ),
      index,
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
        stepsJob(named("        with:\n          bun-version-file: package.json\n")),
        index,
      ),
    ).toStrictEqual([]);
    const errors = checkWorkflow(".github/workflows/ci.yml", stepsJob(named("")), index);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bun-version-file: package.json");
  });

  it("fails a reference that is not a uses: line", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(`      - run: bun install # needs oven-sh/setup-bun@\n`),
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("uses:");
  });

  it("fails a uses: line that resolves to no step", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      `jobs:\n  t:\n    steps: []\nuses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6\n`,
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot resolve the step");
  });
});

describe("checkWorkflow tool bins", () => {
  it("passes a run step whose bin a declared dependency provides", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(`      - run: bunx vp test --project unit tests/x.test.ts\n`),
      index,
    );
    expect(errors).toStrictEqual([]);
  });

  it("fails a bunx call no declared dependency serves", () => {
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(`      - run: bunx vitest run tests/x.test.ts\n`),
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("vitest");
  });

  it.each(["npx vitest", "bun x vitest", "npm exec -- vitest"])(
    "checks the runner form %s",
    (tool) => {
      const errors = checkWorkflow(
        ".github/workflows/ci.yml",
        stepsJob(`      - run: ${tool} tests/x.test.ts\n`),
        index,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("vitest");
    },
  );

  it("scopes the dependency search to the step's working-directory manifest", () => {
    expect(
      checkWorkflow(
        ".github/workflows/gateway.yml",
        stepsJob(`      - run: bunx wrangler deploy\n        working-directory: apps/gateway\n`),
        scopedIndex(),
      ),
    ).toStrictEqual([]);
    expect(
      checkWorkflow(
        ".github/workflows/ci.yml",
        stepsJob(`      - run: bunx wrangler deploy\n`),
        scopedIndex(),
      ),
    ).toHaveLength(1);
  });

  it("reads a job's defaults.run.working-directory", () => {
    const errors = checkWorkflow(
      ".github/workflows/gateway.yml",
      `jobs:\n  t:\n    defaults:\n      run:\n        working-directory: apps/gateway\n    steps:\n      - run: bunx wrangler deploy\n`,
      defaultsIndex(),
    );
    expect(errors).toStrictEqual([]);
  });

  it("checks an explicitly -p-named package as a declaration, not a bin", () => {
    expect(
      checkWorkflow(
        ".github/workflows/ci.yml",
        stepsJob(`      - run: npx -p vite-plus vp test\n`),
        index,
      ),
    ).toStrictEqual([]);
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(`      - run: npx --package undeclared-pkg run-it\n`),
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("undeclared-pkg");
  });

  it("checks a --package=-named package as a declaration too", () => {
    expect(
      checkWorkflow(
        ".github/workflows/ci.yml",
        stepsJob(`      - run: npx --package=vite-plus vp test\n`),
        index,
      ),
    ).toStrictEqual([]);
    const errors = checkWorkflow(
      ".github/workflows/ci.yml",
      stepsJob(`      - run: npx --package=undeclared-pkg run-it\n`),
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("undeclared-pkg");
  });

  it("checks composite action runs.steps", () => {
    const errors = checkWorkflow(
      ".github/actions/setup/action.yml",
      `runs:\n  using: composite\n  steps:\n    - run: bunx vitest run tests/x.test.ts\n      shell: bash\n`,
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("vitest");
  });
});

describe("checkWorkflow reusable workflows", () => {
  const TOOLCHAIN = `  toolchain:\n    runs-on: ubuntu-latest\n    outputs:\n      bun-version: \${{ steps.bun.outputs.bun-version }}\n    steps:\n      - id: bun\n        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6\n        with:\n          bun-version-file: package.json\n`;
  const reusable = (extra: string): string =>
    `jobs:\n${TOOLCHAIN}  smoke:\n${extra}    uses: qntx/workflows/.github/workflows/ci-hermes.yml@b1a930e790044f34f06bd5e1e0ede9e7dd5fa122\n    with:\n      bun-version: \${{ needs.toolchain.outputs.bun-version }}\n`;

  it("passes a gated reusable call handed the toolchain output", () => {
    const errors = checkWorkflow(
      ".github/workflows/hermes.yml",
      reusable(`    needs: toolchain\n`),
      index,
    );
    expect(errors).toStrictEqual([]);
  });

  it("fails a reusable call not waiting on toolchain", () => {
    const errors = checkWorkflow(".github/workflows/hermes.yml", reusable(""), index);
    expect(errors.some((e) => e.includes("needs: toolchain"))).toBe(true);
  });

  it("fails a reusable call handed a literal or missing bun-version", () => {
    const literal = reusable(`    needs: toolchain\n`).replace(
      `bun-version: \${{ needs.toolchain.outputs.bun-version }}`,
      "bun-version: '1.4.4'",
    );
    const errors = checkWorkflow(".github/workflows/hermes.yml", literal, index);
    expect(errors.some((e) => e.includes("bun-version"))).toBe(true);
  });

  it("fails when no toolchain job produces the version", () => {
    const errors = checkWorkflow(
      ".github/workflows/hermes.yml",
      `jobs:\n  smoke:\n    needs: toolchain\n    uses: qntx/workflows/.github/workflows/ci-hermes.yml@abc\n    with:\n      bun-version: \${{ needs.toolchain.outputs.bun-version }}\n`,
      index,
    );
    expect(errors.some((e) => e.includes("toolchain job"))).toBe(true);
  });

  it("fails a toolchain job whose output does not name the bun step", () => {
    const bad = TOOLCHAIN.replace(
      `bun-version: \${{ steps.bun.outputs.bun-version }}`,
      `bun-version: \${{ steps.other.outputs.bun-version }}`,
    );
    const errors = checkWorkflow(
      ".github/workflows/hermes.yml",
      reusable(`    needs: toolchain\n`).replace(TOOLCHAIN, bad),
      index,
    );
    expect(errors.some((e) => e.includes("steps.bun.outputs.bun-version"))).toBe(true);
  });

  it("skips the allow-listed release reusable (it installs no Bun)", () => {
    const errors = checkWorkflow(
      ".github/workflows/release.yml",
      `jobs:\n  release:\n    uses: qntx/workflows/.github/workflows/release.yml@b1a930e790044f34f06bd5e1e0ede9e7dd5fa122\n`,
      index,
    );
    expect(errors).toStrictEqual([]);
  });

  it("flags the old hermes.yml — a reusable call with no Bun version at all", () => {
    // The pre-fix workflow: the reusable call ran whatever Bun its definition defaulted to.
    const old = `jobs:\n  smoke:\n    uses: qntx/workflows/.github/workflows/ci-hermes.yml@b1a930e790044f34f06bd5e1e0ede9e7dd5fa122\n    permissions:\n      contents: read\n    with:\n      hermes-commit: d412d3bd851278712c20cca25d094e32641a0465\n      script: smoke:hermes\n      working-directory: packages/wallet-worker\n`;
    const errors = checkWorkflow(".github/workflows/hermes.yml", old, index);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("toolchain"))).toBe(true);
  });
});

describe("checkWorkflow setup-node", () => {
  const nodeStep = (withBlock: string): string =>
    stepsJob(
      `      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n${withBlock}`,
    );

  it("passes an exact X.Y.Z pin", () => {
    expect(
      checkWorkflow(
        ".github/workflows/publish-npm.yml",
        nodeStep(`        with:\n          node-version: "24.22.3"\n`),
        index,
      ),
    ).toStrictEqual([]);
  });

  it.each([
    ["a major-only version", 'node-version: "24"'],
    ["a range", 'node-version: "^24"'],
    ["an lts alias", 'node-version: "lts/*"'],
    ["a two-part version", 'node-version: "24.22"'],
  ])("fails %s", (_name, line) => {
    const errors = checkWorkflow(
      ".github/workflows/publish-npm.yml",
      nodeStep(`        with:\n          ${line}\n`),
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("node-version");
  });

  it("fails node-version-file", () => {
    const errors = checkWorkflow(
      ".github/workflows/publish-npm.yml",
      nodeStep(`        with:\n          node-version-file: .nvmrc\n`),
      index,
    );
    expect(errors.some((e) => e.includes("node-version-file"))).toBe(true);
  });
});

describe("checkManifest", () => {
  it("passes a root manifest with a bun packageManager pin", () => {
    expect(
      checkManifest(
        "package.json",
        { packageManager: "bun@1.4.4", scripts: { test: "vp test" } },
        true,
        index,
      ),
    ).toStrictEqual([]);
  });

  it.each([
    ["missing", {}],
    ["not bun", { packageManager: "npm@11.0.0" }],
    ["a range", { packageManager: "bun@^1.4.4" }],
    ["two-part", { packageManager: "bun@1.4" }],
  ])("fails a root manifest whose packageManager is %s", (_name, manifest) => {
    const errors = checkManifest(
      "package.json",
      { ...manifest, scripts: { test: "vp test" } },
      true,
      index,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("packageManager");
  });

  it("fails any manifest keeping devEngines.packageManager", () => {
    const pkg = {
      devEngines: { packageManager: { name: "bun", version: "1.4.4" } },
    };
    expect(checkManifest("packages/wallet/package.json", pkg, false, index)).toHaveLength(1);
    expect(
      checkManifest(
        "package.json",
        { ...pkg, packageManager: "bun@1.4.4", scripts: { test: "vp test" } },
        true,
        index,
      ),
    ).toHaveLength(1);
  });

  it("requires the root test script to run the root suite outside vp run", () => {
    expect(
      checkManifest(
        "package.json",
        {
          packageManager: "bun@1.4.4",
          scripts: { test: "vp run --concurrency-limit 1 -r test && vp test" },
        },
        true,
        index,
      ),
    ).toStrictEqual([]);
    expect(
      checkManifest(
        "package.json",
        { packageManager: "bun@1.4.4", scripts: { test: "vp run --concurrency-limit 1 -r test" } },
        true,
        index,
      ),
    ).toHaveLength(1);
    // The rule only applies to the root manifest.
    expect(
      checkManifest(
        "packages/wallet/package.json",
        { scripts: { test: "vp run --concurrency-limit 1 -r test" } },
        false,
        index,
      ),
    ).toStrictEqual([]);
  });

  it("checks manifest scripts like run commands", () => {
    expect(
      checkManifest(
        "packages/wallet/package.json",
        { scripts: { test: "bunx vitest run tests/x.test.ts" } },
        false,
        index,
      ),
    ).toHaveLength(1);
    expect(
      checkManifest(
        "packages/wallet/package.json",
        { scripts: { test: "bunx vp test --project unit" } },
        false,
        index,
      ),
    ).toStrictEqual([]);
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
  it("has no toolchain findings over real workflows and manifests", () => {
    expect(checkRepository()).toStrictEqual([]);
  });
});
