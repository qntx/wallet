import { describe, expect, it } from "vite-plus/test";

import {
  TOKEN_DECIMALS_MAX,
  TOKEN_SYMBOL_MAX,
  isAscii,
  safeDecimals,
  safeDisplayText,
} from "../src/display.ts";

describe("safeDisplayText", () => {
  it("trims and passes plain text, including non-ASCII letters", () => {
    expect(safeDisplayText("  USDC ", TOKEN_SYMBOL_MAX)).toBe("USDC");
    expect(safeDisplayText("ÉTH", TOKEN_SYMBOL_MAX)).toBe("ÉTH");
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["NUL", "A\u0000B"],
    ["newline inside", "A\nB"],
    ["DEL", "A\u007FB"],
    ["C1 control", "A\u0085B"],
    ["Arabic letter mark", "A\u061CB"],
    ["left-to-right mark", "A\u200EB"],
    ["right-to-left override", "A\u202EB"],
    ["isolate", "A\u2066B"],
    ["zero-width space", "A\u200BB"],
    ["zero-width joiner", "A\u200DB"],
    ["word joiner", "A\u2060B"],
    ["BOM", "A\uFEFFB"],
  ])("rejects %s", (_name, text) => {
    expect(safeDisplayText(text, TOKEN_SYMBOL_MAX)).toBeUndefined();
  });

  it("caps the length in code points, not UTF-16 units", () => {
    expect(safeDisplayText("A".repeat(32), 32)).toHaveLength(32);
    expect(safeDisplayText("A".repeat(33), 32)).toBeUndefined();
    expect(safeDisplayText("😀".repeat(32), 32)).toBeDefined();
    expect(safeDisplayText("😀".repeat(33), 32)).toBeUndefined();
  });
});

describe("isAscii and safeDecimals", () => {
  it("tells ASCII from the rest", () => {
    expect(isAscii("USDC-1")).toBe(true);
    expect(isAscii("USDС")).toBe(false);
  });

  it("accepts integers 0..36 only", () => {
    expect(safeDecimals(0)).toBe(0);
    expect(safeDecimals(TOKEN_DECIMALS_MAX)).toBe(36);
    for (const bad of [-1, 37, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(safeDecimals(bad)).toBeUndefined();
    }
  });
});
