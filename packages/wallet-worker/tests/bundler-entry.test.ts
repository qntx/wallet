import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const host = readFileSync(join(import.meta.dirname, "../src/browser/index.ts"), "utf8");

describe("browser host worker entry", () => {
  it("spawns the kernel through the literal form bundlers treat as a worker entry", () => {
    // A precomputed URL makes bundlers copy kernel.worker.js alone, without its chunks.
    expect(host).toMatch(/new Worker\(new URL\("kernel\.worker\.js", import\.meta\.url\)/);
  });
});
