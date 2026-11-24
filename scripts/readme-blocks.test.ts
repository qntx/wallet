/// <reference types="node" />
import { describe, expect, it } from "vite-plus/test";

import { readmeBlocks } from "./readme-blocks.ts";

const DOC = [
  "# Readme",
  "",
  "```ts",
  "export const a = 1;",
  "```",
  "",
  "```text",
  "not code",
  "```",
  "",
  "```tsx",
  "export const b = <div />;",
  "```",
  "",
  "```typescript",
  "export const c = 3;",
  "```",
  "",
  "```sh",
  "echo no",
  "```",
].join("\n");

describe("readmeBlocks", () => {
  it("extracts ts, typescript and tsx fences in order", () => {
    const blocks = readmeBlocks(DOC);
    expect(blocks.map((b) => b.lang)).toStrictEqual(["ts", "tsx", "typescript"]);
    expect(blocks[0]?.body).toBe("export const a = 1;");
    expect(blocks[1]?.body).toBe("export const b = <div />;");
    expect(blocks[2]?.body).toBe("export const c = 3;");
  });

  it("ignores other languages and empty docs", () => {
    expect(readmeBlocks("```json\n{}\n```\n")).toHaveLength(0);
    expect(readmeBlocks("no fences")).toHaveLength(0);
  });

  it("keeps a block's internal fences free — body ends at the first ```", () => {
    const blocks = readmeBlocks("```ts\nconst x = `a`;\n```\ntail\n```ts\n2\n```\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.body).toBe("const x = `a`;");
  });
});
