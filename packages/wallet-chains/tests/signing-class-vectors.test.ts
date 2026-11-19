import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { isBlindIntent } from "../src/index.ts";
import type { DisplayIntent, SignRequest } from "../src/index.ts";

type VectorCase = {
  readonly name: string;
  readonly request: SignRequest & {
    readonly message?: { readonly $bytes: string };
    readonly typedData?: unknown;
  };
  readonly verifiability: string;
  readonly blind: string | null;
};

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/signing-classes.json"),
    "utf8",
  ),
) as { signer: string; cases: VectorCase[] };

/** Rehydrates the JSON-only request forms (`$bytes`, parsed typed-data doc). */
const request = (v: VectorCase): SignRequest => {
  if (v.request.kind === "evm.personal-message") {
    return { ...v.request, message: hexToBytes(v.request.message.$bytes.slice(2)) };
  }
  if (v.request.kind === "evm.typed-data") {
    return { ...v.request, typedData: JSON.stringify(v.request.typedData) };
  }
  return v.request;
};

const blindOf = (intent: DisplayIntent): string | null => intent.blind ?? null;

describe("signing-classes vectors", () => {
  it("has one case per expected class and blind reason", () => {
    expect(vectors.cases).toHaveLength(20);
    expect(new Set(vectors.cases.map((v) => v.name)).size).toBe(20);
  });

  it.each(vectors.cases)("$name", (v) => {
    const intent = decodeEvm(request(v), vectors.signer);
    expect(intent.verifiability).toBe(v.verifiability);
    expect(blindOf(intent)).toBe(v.blind);
    expect(isBlindIntent(intent)).toBe(v.blind !== null);
  });
});
