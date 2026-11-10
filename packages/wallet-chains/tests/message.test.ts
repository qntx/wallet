import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { parseCompiledMessage } from "../src/solana/message.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
) as { core: ReadonlyArray<{ message: string }> };

const message = hexToBytes(vectors.core[0]!.message.slice(2));

describe("parseCompiledMessage", () => {
  it("parses an exact compiled message", () => {
    expect(parseCompiledMessage(message).instructions.length).toBeGreaterThan(0);
  });

  it.each([1, 32])("rejects %i trailing bytes", (extra) => {
    const padded = Uint8Array.from([...message, ...new Uint8Array(extra)]);
    expect(() => parseCompiledMessage(padded)).toThrow("compiled message has trailing bytes");
  });
});
