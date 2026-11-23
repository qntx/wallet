/// <reference types="node" />
import { describe, expect, it } from "vite-plus/test";

import {
  checkBlocks,
  checkFileRefs,
  checkMigrationGuide,
  checkSectionRefs,
  embeddedBlocks,
  releaseEntry,
  sectionHeadings,
} from "./check-migration-guide.ts";

const GUIDE = [
  "# Migrating from 0.13.0",
  "",
  "## 1. One",
  "",
  "[`tests/migration/one.ts`](tests/migration/one.ts):",
  "",
  "```ts",
  "export const one = 1;",
  "```",
  "",
  "## 2. Two",
  "",
  "See §1 for the vault reset.",
  "",
  "## [",
].join("\n");

describe("embeddedBlocks", () => {
  it("finds only ```ts blocks directly under a link line", () => {
    const blocks = embeddedBlocks(GUIDE);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.file).toBe("one.ts");
    expect(blocks[0]?.content).toBe("export const one = 1;");
  });

  it("ignores fenced blocks not under a link line and other languages", () => {
    const guide = [
      "prose",
      "",
      "```ts",
      "export const stray = 0;",
      "```",
      "",
      "[`tests/migration/one.ts`](tests/migration/one.ts):",
      "",
      "```bash",
      "echo no",
      "```",
    ].join("\n");
    expect(embeddedBlocks(guide)).toHaveLength(0);
  });
});

describe("checkBlocks", () => {
  it("reports a stale block", () => {
    const result = checkBlocks(GUIDE, () => "export const one = 2;\n", false);
    expect(result.findings).toStrictEqual([
      "MIGRATION.md: embedded block for tests/migration/one.ts is stale",
    ]);
    expect(result.updated).toStrictEqual([]);
  });

  it("ignores the file's trailing newline", () => {
    const result = checkBlocks(GUIDE, () => "export const one = 1;\n", false);
    expect(result.findings).toStrictEqual([]);
  });

  it("reports a block whose file is missing", () => {
    const result = checkBlocks(GUIDE, () => undefined, false);
    expect(result.findings).toStrictEqual([
      "MIGRATION.md: link names tests/migration/one.ts, which does not exist",
    ]);
  });

  it("rewrites stale blocks under --update and reports the rewritten files", () => {
    const result = checkBlocks(GUIDE, () => "export const one = 2;\n", true);
    expect(result.findings).toStrictEqual([]);
    expect(result.updated).toStrictEqual(["one.ts"]);
    expect(result.migration).toContain("```ts\nexport const one = 2;\n```");
    expect(
      checkBlocks(result.migration, () => "export const one = 2;\n", false).findings,
    ).toStrictEqual([]);
  });
});

describe("checkFileRefs", () => {
  it("reports a snippet file nothing references and a reference to a missing file", () => {
    const guide = `${GUIDE}\n[\`tests/migration/ghost.ts\`](tests/migration/ghost.ts)\n`;
    expect(checkFileRefs(guide, ["one.ts", "orphan.ts"]).toSorted()).toStrictEqual([
      "MIGRATION.md: references tests/migration/ghost.ts, which does not exist",
      "MIGRATION.md: tests/migration/orphan.ts is not referenced",
    ]);
  });
});

describe("section refs", () => {
  it("collects `## <n>.` headings and rejects references to absent sections", () => {
    const headings = sectionHeadings(GUIDE);
    expect([...headings].toSorted((a, b) => a - b)).toStrictEqual([1, 2]);
    expect(checkSectionRefs("x.ts", "see §1 then §9 and §99 again §9", headings)).toStrictEqual([
      "x.ts: §9 names no `## 9.` heading in MIGRATION.md",
      "x.ts: §99 names no `## 99.` heading in MIGRATION.md",
    ]);
  });

  it("ignores `§` followed by a non-digit", () => {
    expect(checkSectionRefs("x", "§A §- § §3", new Set([3]))).toStrictEqual([]);
  });
});

describe("releaseEntry", () => {
  it("returns the first versioned entry up to the next one", () => {
    const changelog =
      "# Changelog\n\n## [0.14.0] - unreleased\n\n### Added\n\nx §2\n\n## [0.13.0] - 2026-01-01\n\ny §99\n";
    expect(releaseEntry(changelog)).toBe("## [0.14.0] - unreleased\n\n### Added\n\nx §2\n");
  });

  it("falls through an empty `## [Unreleased]` to the first versioned entry", () => {
    const changelog =
      "# Changelog\n\n## [Unreleased]\n\n## [0.14.0] - 2026-11-23\n\nx §2\n\n## [0.13.0] - 2026-01-01\n\ny §3\n";
    expect(releaseEntry(changelog)).toBe("## [0.14.0] - 2026-11-23\n\nx §2\n");
  });

  it("uses a non-empty `## [Unreleased]` instead of the first versioned entry", () => {
    const changelog =
      "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\nwip §4\n\n## [0.14.0] - 2026-11-23\n\nx §2\n";
    expect(releaseEntry(changelog)).toBe("## [Unreleased]\n\n### Fixed\n\nwip §4\n");
  });

  it("returns empty without a `## [` heading", () => {
    expect(releaseEntry("# Changelog\n\nno entries\n")).toBe("");
  });
});

describe("checkMigrationGuide", () => {
  const base = {
    migration: GUIDE,
    changelog: "## [0.14.0]\n\n§2 done\n",
    files: ["one.ts"],
    read: (file: string) => (file === "one.ts" ? "export const one = 1;\n" : undefined),
  };

  it("passes a consistent guide", () => {
    expect(checkMigrationGuide(base)).toStrictEqual([]);
  });

  it("fails a `§` reference inside a snippet file", () => {
    expect(
      checkMigrationGuide({
        ...base,
        read: (file) => new Map([["one.ts", "// see §7\n"]]).get(file),
      }),
    ).toStrictEqual([
      "MIGRATION.md: embedded block for tests/migration/one.ts is stale",
      "tests/migration/one.ts: §7 names no `## 7.` heading in MIGRATION.md",
    ]);
  });

  it("fails a `§` reference in the first changelog entry but not in later ones", () => {
    const changelog = "## [0.14.0]\n\n§8\n\n## [0.13.0]\n\n§9\n";
    expect(checkMigrationGuide({ ...base, changelog })).toStrictEqual([
      "CHANGELOG.md: §8 names no `## 8.` heading in MIGRATION.md",
    ]);
  });

  it("fails a `§` reference in the versioned entry under an empty Unreleased", () => {
    const changelog = "## [Unreleased]\n\n## [0.14.0]\n\n§99\n";
    expect(checkMigrationGuide({ ...base, changelog })).toStrictEqual([
      "CHANGELOG.md: §99 names no `## 99.` heading in MIGRATION.md",
    ]);
  });
});
