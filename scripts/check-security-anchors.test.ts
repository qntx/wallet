/// <reference types="node" />
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { anchors, check } from "./check-security-anchors.ts";

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sec-anchors-"));
  writeFileSync(join(dir, "a.ts"), "export const present = 1;\nexport function other() {}\n");
  return dir;
};

describe("anchors", () => {
  it("extracts symbols after a path and before `in`", () => {
    const md = "`src/a.ts` `present`/`other` and `present` in `src/a.ts`";
    expect(anchors(md)).toEqual([
      { path: "src/a.ts", symbols: ["present", "other"] },
      { path: "src/a.ts", symbols: ["present"] },
      { path: "src/a.ts", symbols: [] },
    ]);
  });

  it("ignores package specifiers and bare symbols", () => {
    const md = "`@qntx/wallet-native/secure-input` `present` `chain.sign`";
    expect(anchors(md)).toEqual([]);
  });
});

describe("check", () => {
  it("fails on a line-number anchor", () => {
    const dir = fixture();
    expect(check("see `a.ts:12` now", dir)).toEqual([
      'line-number anchor "a.ts:12" — cite the symbol instead',
    ]);
  });

  it("fails on a missing file and a missing symbol", () => {
    const dir = fixture();
    const failures = check("`src/b.ts` `present` and `a.ts` `absent`", dir);
    expect(failures).toEqual([
      '"src/b.ts" does not exist',
      '"a.ts" has no identifier `absent`',
    ]);
  });

  it("fails on a bare filename that is not a repo path", () => {
    const dir = fixture();
    expect(check("(`account.ts` `present`)", dir)).toEqual([
      '"account.ts" does not exist',
    ]);
  });

  it("passes when every pair holds", () => {
    const dir = fixture();
    expect(check("`a.ts` `present`/`other`; also `other` in `a.ts`.", dir)).toEqual([]);
  });
});
