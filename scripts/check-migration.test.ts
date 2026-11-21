import { describe, expect, it } from "vite-plus/test";

import { exportedNames, namedIn, removedExports, removedSection } from "./check-migration.ts";

const report = (body: string): string => `## API Report\n\n\`\`\`ts\n${body}\n\`\`\`\n`;

describe("exportedNames", () => {
  it("reads every declaration kind and export lists, not unexported declarations", () => {
    const names = exportedNames(
      report(
        [
          "export function accepts(schema: unknown): boolean;",
          "export const RPC_BATCH_MAX = 20;",
          "export declare const x: number;",
          "export type Caip2 = string;",
          "export interface Endpoint {}",
          "export abstract class Base {}",
          "export enum Kind { A }",
          "export namespace ns {}",
          "export { a, b as c }",
          "type Hidden = string;",
        ].join("\n"),
      ),
    );
    expect([...names].toSorted()).toStrictEqual([
      "Base",
      "Caip2",
      "Endpoint",
      "Kind",
      "RPC_BATCH_MAX",
      "a",
      "accepts",
      "c",
      "ns",
      "x",
    ]);
  });
});

describe("removedExports", () => {
  it("lists names a released entry had and the current one lacks, including a dropped entry", () => {
    const before = new Map([
      ["index", report("export const kept = 1;\nexport const gone = 2;")],
      ["old-entry", report("export function moved(): void;")],
    ]);
    const after = new Map([["index", report("export const kept = 1;\nexport const added = 3;")]]);
    expect(removedExports("@qntx/x", before, after)).toStrictEqual([
      { pkg: "@qntx/x", entry: "index", name: "gone" },
      { pkg: "@qntx/x", entry: "old-entry", name: "moved" },
    ]);
  });
});

describe("removedSection and namedIn", () => {
  const migration = [
    "# Migrating",
    "## 12. Other",
    "`outside`",
    "## 13. Removed APIs",
    "| `INSTALL_ID_HEADER`, `installId` | `CLIENT_ID_HEADER` |",
    "| `engine.spark.setAccounts` | nothing |",
    "## 14. Next",
    "`after`",
  ].join("\n");

  it("takes only §13 and splits backticked spans into words", () => {
    const named = namedIn(removedSection(migration));
    expect(named.has("INSTALL_ID_HEADER")).toBe(true);
    expect(named.has("setAccounts")).toBe(true);
    expect(named.has("outside")).toBe(false);
    expect(named.has("after")).toBe(false);
  });

  it("refuses a guide without §13", () => {
    expect(() => removedSection("# Migrating\n## 1. Vault")).toThrow(/13\. Removed APIs/);
  });
});
