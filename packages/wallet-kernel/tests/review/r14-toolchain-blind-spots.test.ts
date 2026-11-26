/// <reference types="node" />
/**
 * Review PoC R14-01: `scripts/check-toolchain.ts` is the gate that keeps every CI tool on the
 * lockfile and the single Bun pin. It still accepts several shapes that resolve tools outside the
 * lockfile or the 7-day cooldown, and the repository already uses some of them. Each test asserts
 * today's faulty behaviour — the checker returns no finding — so it passes now and fails once the
 * blind spot is closed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { checkBunfig, checkWorkflow } from "../../../../scripts/check-toolchain.ts";
import type { DependencyIndex } from "../../../../scripts/check-toolchain.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const index: DependencyIndex = {
  bin: (name) => (name === "vp" ? "vite-plus" : undefined),
  declared: (name) => name === "vite-plus",
};

const SETUP_BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const job = (steps: string): string =>
  `jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
const composite = (steps: string): string =>
  `name: x\nruns:\n  using: composite\n  steps:\n${steps}`;

describe("composite actions: setup-bun / setup-node steps are never version-checked", () => {
  it("the same floating setup-bun step is a finding in a job but not in a composite action", () => {
    const step = `      - uses: ${SETUP_BUN}\n        with:\n          bun-version: latest\n`;
    expect(checkWorkflow(".github/workflows/x.yml", job(step), index).length).toBeGreaterThan(0);
    const inAction = `    - uses: ${SETUP_BUN}\n      with:\n        bun-version: latest\n`;
    expect(
      checkWorkflow(".github/actions/setup/action.yml", composite(inAction), index),
    ).toStrictEqual([]);
  });

  it("a composite setup-node with a floating major passes", () => {
    const inAction = `    - uses: ${SETUP_NODE}\n      with:\n        node-version: "24"\n`;
    expect(
      checkWorkflow(".github/actions/node/action.yml", composite(inAction), index),
    ).toStrictEqual([]);
  });
});

describe("run: commands — installers other than bunx/npx/npm exec are invisible", () => {
  it.each([
    "curl -fsSL https://bun.sh/install | bash",
    "npm install -g some-tool",
    "npm i some-tool",
    "bun add -g some-tool",
    "pnpm dlx some-tool",
    "yarn dlx some-tool",
    "pip install some-tool",
    'sh -c "bunx some-tool"',
    "docker run --rm node:latest node -v",
  ])("accepts `%s`", (command) => {
    expect(
      checkWorkflow(".github/workflows/x.yml", job(`      - run: ${command}\n`), index),
    ).toStrictEqual([]);
  });

  it("the quoted form differs from the bare form only by the quote", () => {
    expect(
      checkWorkflow(".github/workflows/x.yml", job("      - run: sh -c bunx some-tool\n"), index)
        .length,
    ).toBeGreaterThan(0);
  });
});

describe("job/step shapes outside run: and setup-bun are not checked", () => {
  it("container and service images by floating tag pass", () => {
    const source =
      "jobs:\n  t:\n    runs-on: ubuntu-latest\n    container:\n      image: node:latest\n" +
      "    services:\n      db:\n        image: postgres:latest\n    steps:\n      - run: echo ok\n";
    expect(checkWorkflow(".github/workflows/x.yml", source, index)).toStrictEqual([]);
  });

  it("an allow-listed reusable workflow on a branch ref passes", () => {
    const source =
      "jobs:\n  release:\n    uses: qntx/workflows/.github/workflows/release.yml@main\n";
    expect(checkWorkflow(".github/workflows/release.yml", source, index)).toStrictEqual([]);
  });

  it("a third-party toolchain action with a floating version input passes", () => {
    const step =
      "      - uses: actions/setup-java@0000000000000000000000000000000000000000\n" +
      '        with:\n          distribution: temurin\n          java-version: "25"\n';
    expect(checkWorkflow(".github/workflows/x.yml", job(step), index)).toStrictEqual([]);
  });
});

describe("bunfig: only the first line of minimumReleaseAgeExcludes is read", () => {
  it("a bare (every-version) exclusion on a continuation line passes", () => {
    const source =
      '[install]\nminimumReleaseAge = 604800\nminimumReleaseAgeExcludes = [\n  "@qntx/fiat24",\n]\n';
    expect(checkBunfig(source)).toStrictEqual([]);
    // The same entry on one line is caught — the rule exists, the parser misses the layout.
    expect(checkBunfig('minimumReleaseAgeExcludes = ["@qntx/fiat24"]')).toHaveLength(1);
  });
});

describe("live instances in this repository", () => {
  it("the Browser workflow's consumer smoke npm-installs fresh transitive deps with lifecycle scripts", () => {
    expect(read(".github/workflows/browser.yml")).toContain("bun run test:consumer");
    const smoke = read("packages/wallet-worker/scripts/consumer-smoke.ts");
    expect(smoke).toMatch(/run\(\s*"npm",\s*\[\s*"install"/);
    expect(smoke).not.toContain("--ignore-scripts");
    expect(smoke).not.toContain("package-lock");
    expect(smoke).not.toContain("--before");
  });

  it("card.yml installs whatever JDK 25.x is latest", () => {
    expect(read(".github/workflows/card.yml")).toMatch(/java-version: "25"\n/);
  });

  it("the OneKey emulator images pip-install unpinned build tools", () => {
    const dockerfile = read("packages/wallet-kernel/tests/onekey-emulator/Dockerfile.pro");
    expect(dockerfile).toMatch(/"scons" \\\n\s+"mako"/);
  });

  it("apps/harness resolves from its own lockfile with no release-age cooldown", () => {
    expect(existsSync(join(ROOT, "apps/harness/bun.lock"))).toBe(true);
    expect(existsSync(join(ROOT, "apps/harness/bunfig.toml"))).toBe(false);
    const native = read(".github/workflows/native.yml");
    expect(native).toContain("working-directory: apps/harness");
  });
});
