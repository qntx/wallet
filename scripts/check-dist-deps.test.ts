/// <reference types="node" />
/**
 * Check-dist-deps guards the published dependency contract both ways: an import a packed file makes
 * must be declared, and a `dependencies` entry must be imported by a packed file — the dcbor shape
 * (commit 5028f873) where a declared prerelease shipped to consumers unused. Comments and method
 * calls must not count as imports.
 */
import { describe, expect, it } from "vite-plus/test";

import { checkDistDeps, stripComments } from "./check-dist-deps.ts";
import type { PackedFile } from "./check-dist-deps.ts";

const file = (source: string, path = "dist/index.mjs"): PackedFile => ({ path, source });

describe("checkDistDeps", () => {
  it("fails a packed import that is not declared", () => {
    const errors = checkDistDeps("pkg", { dependencies: { declared: "1.0.0" } }, [
      file('import a from "declared";\nimport b from "sneaky";\nexport { c } from "declared/sub";'),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("sneaky");
  });

  it("fails a dependencies entry no packed file imports", () => {
    // The dcbor miss: a prerelease declared but only used in tests.
    const errors = checkDistDeps(
      "pkg",
      { dependencies: { "@blockchaincommons/dcbor": "1.0.0-beta.5" } },
      [file('import { x } from "something-else";')],
    );
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.includes("@blockchaincommons/dcbor"))).toBe(true);
    expect(errors.some((e) => e.includes("something-else"))).toBe(true);
  });

  it("passes when every import is declared and every dependency is used", () => {
    const errors = checkDistDeps(
      "pkg",
      {
        dependencies: { "real-dep": "1.0.0", "@scope/dep": "2.0.0" },
        peerDependencies: { "peer-dep": "3.0.0" },
      },
      [
        file('import a from "real-dep";\nimport type { T } from "@scope/dep/sub";'),
        file('export { p } from "peer-dep";', "dist/index.d.mts"),
      ],
    );
    expect(errors).toStrictEqual([]);
  });

  it("counts dynamic import and require as uses", () => {
    const errors = checkDistDeps(
      "pkg",
      { dependencies: { "lazy-dep": "1.0.0", "cjs-dep": "1.0.0" } },
      [file('const a = await import("lazy-dep");\nconst b = require("cjs-dep");', "dist/x.cjs")],
    );
    expect(errors).toStrictEqual([]);
  });

  it("does not check peer or optional entries for use", () => {
    const errors = checkDistDeps(
      "pkg",
      {
        dependencies: { "real-dep": "1.0.0" },
        peerDependencies: { "unused-peer": "1.0.0" },
        optionalDependencies: { "unused-optional": "1.0.0" },
      },
      [file('import a from "real-dep";')],
    );
    expect(errors).toStrictEqual([]);
  });

  it("ignores imports inside comments and doc annotations", () => {
    const errors = checkDistDeps("pkg", { dependencies: { "real-dep": "1.0.0" } }, [
      file(
        'import a from "real-dep";\n' +
          '// import fake from "ghost-dep";\n' +
          '/* import { X } from "block-dep" */\n' +
          '/** @type {import("@types/ghost").T} */\n' +
          "const t = 1;\n",
      ),
    ]);
    expect(errors).toStrictEqual([]);
  });

  it("does not read member calls like session.require(x) as CommonJS requires", () => {
    const errors = checkDistDeps("pkg", { dependencies: { "real-dep": "1.0.0" } }, [
      file(
        'import a from "real-dep";\n' +
          'ctx.session.require("not-a-module");\n' +
          'obj.requireFromRn.resolve("also-not");\n',
      ),
    ]);
    expect(errors).toStrictEqual([]);
  });

  it("does not count relative, node: or bun: specifiers as uses", () => {
    const errors = checkDistDeps("pkg", { dependencies: { "real-dep": "1.0.0" } }, [
      file('import "./local.mjs";\nimport { x } from "node:fs";\nimport a from "real-dep";'),
    ]);
    expect(errors).toStrictEqual([]);
  });

  it("flags imports from a packed .js helper outside dist", () => {
    const errors = checkDistDeps("pkg", { dependencies: { "real-dep": "1.0.0" } }, [
      file('import a from "real-dep";'),
      file('require("helper-dep")', "scripts/tool.js"),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("helper-dep");
  });
});

describe("stripComments", () => {
  it("blanks comments but keeps strings, templates and line structure", () => {
    const source =
      'const url = "https://x"; // note from "y"\n' +
      "/* from 'z' */ const tpl = `a" +
      "$" +
      "{b}c`;\n" +
      "const ok = 'from \\'q\\'';\n";
    const stripped = stripComments(source);
    expect(stripped).not.toContain("note");
    expect(stripped).not.toContain("'z'");
    expect(stripped).toContain('"https://x"');
    expect(stripped).toContain("`a" + "$" + "{b}c`");
    expect(stripped.split("\n")).toHaveLength(4);
  });

  it("keeps a string containing a comment opener intact", () => {
    const stripped = stripComments('const s = "a /* b";\nconst t = require("dep");\n');
    expect(stripped).toContain('"a /* b"');
    expect(stripped).toContain('require("dep")');
  });
});
