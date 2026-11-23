/**
 * The checkout-free half of check-card-vectors: the committed `vectors/card/` files must carry the
 * SHA-256s SOURCE records, and every copied `*.json` except the host-owned `oracle.json` must be
 * listed there. The applet-side half needs a checkout and is run from the command line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { localViolations, parseSource } from "./check-card-vectors.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const source = parseSource(readFileSync(join(ROOT, "vectors/card/SOURCE"), "utf8"));

describe("check-card-vectors (no checkout)", () => {
  it("parses the SOURCE metadata", () => {
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.path).toBe("spec/vectors");
    expect(source.hashes.size).toBeGreaterThan(0);
  });

  it("finds no local violation against the committed vectors", () => {
    expect(localViolations(ROOT, source)).toStrictEqual([]);
  });
});
