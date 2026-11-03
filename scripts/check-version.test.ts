/**
 * `checkViteAliases` keeps every `vite` alias/override of `@voidzero-dev/vite-plus-core` aligned
 * with the manifest's own `vite-plus` version — the drift this guard rejects is what broke CI on
 * the vite-plus 1.4.0 dependabot bump.
 */
import { describe, expect, it } from "vite-plus/test";

import { checkExactDeps, checkViteAliases } from "./check-version.ts";

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

describe("checkExactDeps", () => {
  it("accepts the forms the repo actually uses", () => {
    const errors = checkExactDeps([
      manifest({
        dependencies: {
          exact: "2.4.0",
          prerelease: "1.0.0-rc.1",
          alias: "npm:@voidzero-dev/vite-plus-core@1.4.0",
          ws: "workspace:*",
          cat: "catalog:tools",
          file: "file:../x",
          link: "link:../../packages/wallet",
        },
      }),
    ]);
    expect(errors).toStrictEqual([]);
  });

  it("accepts a tilde third-party peer but not a caret or a tilde @qntx peer", () => {
    expect(
      checkExactDeps([manifest({ peerDependencies: { "react-native": "~0.88.0" } })]),
    ).toStrictEqual([]);
    expect(
      checkExactDeps([manifest({ peerDependencies: { "react-native": "^0.88.0" } })]),
    ).toHaveLength(1);
    expect(
      checkExactDeps([manifest({ peerDependencies: { "@qntx/nostr": "~0.15.3" } })]),
    ).toHaveLength(1);
  });

  it.each([
    ["dependencies", { dependencies: { dep: "^2.4.0" } }],
    ["devDependencies", { devDependencies: { dep: "~1.0.0" } }],
    ["peerDependencies", { peerDependencies: { dep: ">=1.0.0" } }],
    ["a caret third-party peer", { peerDependencies: { dep: "^1.0.0" } }],
    ["a tilde @qntx peer", { peerDependencies: { "@qntx/x": "~1.0.0" } }],
    ["a bare major", { dependencies: { dep: "1" } }],
    ["a wildcard", { dependencies: { dep: "*" } }],
    ["a non-exact npm alias", { dependencies: { dep: "npm:other@^1.0.0" } }],
  ] as const)("fails on %s", (_label, pkg) => {
    const errors = checkExactDeps([manifest(pkg)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('must be exact');
  });
});
