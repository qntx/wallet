/**
 * `exportTarget` evaluates package `exports` under an importer's active-condition set the way Node
 * and the bundler do — condition keys in exports-object order, first active match wins. The enclave
 * passes the kernel build's conditions so a conditional export resolves the way the real kernel
 * bundle resolves it.
 */
import { describe, expect, it } from "vite-plus/test";

import { exportTarget, ENCLAVE_CONDITIONS, RULES } from "./check-boundaries.ts";
import type { Edge, Violation } from "./check-boundaries.ts";

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

const PROTOCOL = "packages/wallet-kernel/src/modules/card/protocol";

const violationsOf = (from: string, target: Edge["target"]): string[] =>
  RULES.flatMap((rule): Violation[] => {
    const message = rule.check({ from, specifier: "x", typeOnly: false, line: 1, target });
    return message === undefined
      ? []
      : [
          {
            edge: { from, specifier: "x", typeOnly: false, line: 1, target },
            rule: rule.id,
            message,
          },
        ];
  }).map((violation) => violation.rule);

const fileTarget = (path: string): Edge["target"] => ({ kind: "file", path });
const packageTarget = (name: string): Edge["target"] => ({ kind: "package", name, subpath: "." });

describe("card-protocol", () => {
  it.each([
    ["a protocol sibling", fileTarget(`${PROTOCOL}/bytes.ts`)],
    ["@noble/curves", packageTarget("@noble/curves")],
    ["@noble/hashes", packageTarget("@noble/hashes")],
    ["@noble/ciphers", packageTarget("@noble/ciphers")],
    ["@scure/bip32", packageTarget("@scure/bip32")],
  ] as const)("accepts %s", (_name, target) => {
    expect(violationsOf(`${PROTOCOL}/session.ts`, target)).not.toContain("card-protocol");
  });

  it.each([
    ["a kernel file outside the protocol", fileTarget("packages/wallet-kernel/src/platform.ts")],
    [
      "another module inside the kernel",
      fileTarget("packages/wallet-kernel/src/modules/nostr/keys.ts"),
    ],
    ["a foreign crypto package", packageTarget("@scure/bip39")],
    ["a Node builtin", { kind: "builtin", name: "crypto" } as const],
  ] as const)("rejects %s", (_name, target) => {
    expect(violationsOf(`${PROTOCOL}/session.ts`, target)).toContain("card-protocol");
  });

  it("does not constrain files outside the protocol directory", () => {
    expect(
      violationsOf(
        "packages/wallet-kernel/src/modules/nostr/keys.ts",
        packageTarget("@scure/bip39"),
      ),
    ).not.toContain("card-protocol");
  });
});
