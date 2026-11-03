/**
 * `checkViteAliases` keeps every `vite` alias/override of `@voidzero-dev/vite-plus-core` aligned
 * with the manifest's own `vite-plus` version — the drift this guard rejects is what broke CI on
 * the vite-plus 1.4.0 dependabot bump.
 */
import { describe, expect, it } from "vite-plus/test";

import { checkViteAliases } from "./check-version.ts";

const manifest = (pkg: unknown): { path: string; pkg: unknown } => ({
  path: "package.json",
  pkg,
});

describe("checkViteAliases", () => {
  it("passes when the alias matches vite-plus", () => {
    const errors = checkViteAliases([
      manifest({
        dependencies: { vite: "npm:@voidzero-dev/vite-plus-core@1.4.0" },
        devDependencies: { "vite-plus": "1.4.0" },
        overrides: { vite: "npm:@voidzero-dev/vite-plus-core@1.4.0" },
      }),
    ]);
    expect(errors).toStrictEqual([]);
  });

  const stale = "npm:@voidzero-dev/vite-plus-core@1.3.0";
  const devDeps = { "vite-plus": "1.4.0" };

  it.each([
    ["dependencies", { dependencies: { vite: stale }, devDependencies: devDeps }],
    ["devDependencies", { devDependencies: { ...devDeps, vite: stale } }],
    ["overrides", { overrides: { vite: stale }, devDependencies: devDeps }],
  ] as const)("fails on %s drift", (section, pkg) => {
    const errors = checkViteAliases([manifest(pkg)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${section}["vite"]`);
    expect(errors[0]).toContain("expected 1.4.0");
  });

  it("ignores manifests without vite-plus and non-alias vite specs", () => {
    const errors = checkViteAliases([
      manifest({ dependencies: { vite: "npm:@voidzero-dev/vite-plus-core@9.9.9" } }),
      manifest({
        dependencies: { vite: "^7.0.0" },
        devDependencies: { "vite-plus": "1.4.0" },
      }),
    ]);
    expect(errors).toStrictEqual([]);
  });
});
