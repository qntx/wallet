/**
 * `exportTarget` evaluates package `exports` under an importer's active-condition set the way Node
 * and the bundler do — condition keys in exports-object order, first active match wins. The enclave
 * passes the kernel build's conditions so a conditional export resolves the way the real kernel
 * bundle resolves it.
 */
import { describe, expect, it } from "vite-plus/test";

import { exportTarget, ENCLAVE_CONDITIONS } from "./check-boundaries.ts";

describe("exportTarget", () => {
  it("returns a plain string export", () => {
    expect(exportTarget({ ".": "./dist/index.mjs" }, ".")).toBe("./dist/index.mjs");
  });

  it("keeps the import-then-default ESM resolution by default", () => {
    const exports = {
      ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs", default: "./dist/x.mjs" },
    };
    expect(exportTarget(exports, ".")).toBe("./dist/index.mjs");
  });

  it("picks an earlier object key over a later active one", () => {
    const exports = { ".": { default: "./dist/d.mjs", import: "./dist/i.mjs" } };
    expect(exportTarget(exports, ".")).toBe("./dist/d.mjs");
  });

  it.each([
    ["browser target under enclave conditions", ENCLAVE_CONDITIONS, "./src/browser.ts"],
    ["import target under default conditions", undefined, "./dist/index.mjs"],
  ] as const)("%s", (_name, conditions, want) => {
    const exports = {
      "./protocol": {
        browser: "./src/browser.ts",
        import: "./dist/index.mjs",
        default: "./dist/index.mjs",
      },
    };
    // oxlint-disable vitest/no-conditional-in-test -- the table drives both arities
    expect(
      conditions === undefined
        ? exportTarget(exports, "./protocol")
        : exportTarget(exports, "./protocol", conditions),
    ).toBe(want);
    // oxlint-enable vitest/no-conditional-in-test
  });

  it("still honours object order under enclave conditions", () => {
    const exports = {
      ".": { import: "./dist/index.mjs", browser: "./src/browser.ts" },
    };
    expect(exportTarget(exports, ".", ENCLAVE_CONDITIONS)).toBe("./dist/index.mjs");
  });

  it("falls back to default when no earlier condition matches", () => {
    const exports = { ".": { node: "./n.mjs", default: "./d.mjs" } };
    expect(exportTarget(exports, ".", ENCLAVE_CONDITIONS)).toBe("./d.mjs");
  });

  it("returns undefined when no condition matches", () => {
    const exports = { ".": { node: "./n.mjs" } };
    expect(exportTarget(exports, ".")).toBeUndefined();
  });
});
