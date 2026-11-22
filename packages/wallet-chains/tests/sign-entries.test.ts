/**
 * Sign-entry seam — every runtime export of `src/<family>/sign.ts` other than the task signer
 * (`sign<Family>Task`, the private-key leaf the kernel drives) is a raw-key API implemented through
 * `signLocally(`: plan → task signer → assemble, never bespoke signing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import * as bitcoinSign from "../src/bitcoin/sign.ts";
import * as evmSign from "../src/evm/sign.ts";
import * as solanaSign from "../src/solana/sign.ts";
import * as tronSign from "../src/tron/sign.ts";

const FAMILIES = [
  ["bitcoin", bitcoinSign],
  ["evm", evmSign],
  ["solana", solanaSign],
  ["tron", tronSign],
] as const;

/** The source segment an `export const name` spans: its declaration to the next export. */
const segmentOf = (source: string, name: string): string => {
  const marker = `export const ${name}`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`${name} is not an exported const`);
  }
  const next = source.indexOf("export ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
};

describe("family /sign entries", () => {
  it.each(FAMILIES)(
    "%s: exports are exactly the task signer plus signLocally APIs",
    (family, mod) => {
      const task = `sign${family[0]?.toUpperCase()}${family.slice(1)}Task`;
      const exports = Object.keys(mod).toSorted();
      const expected = exports.filter((name) => name !== task);
      expect(exports).toContain(task);
      const source = readFileSync(
        join(import.meta.dirname, "..", "src", family, "sign.ts"),
        "utf8",
      );
      for (const name of expected) {
        expect(segmentOf(source, name), `${family}.${name} runs through signLocally`).toContain(
          "signLocally(",
        );
      }
    },
  );
});
