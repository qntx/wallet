import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";
import { decodeEvm } from "@qntx/wallet-chains/evm";

import { chainPrompt } from "../src/modules/chains/prompt.ts";

/**
 * vectors/chains/fiat24.json — the expected prompts are written by hand in
 * scripts/vectors/fiat24.ts, not captured from the decoder or this prompt code; this test
 * asserts the real chainPrompt output equals them byte-for-byte in both locales.
 */
type VectorCase = {
  readonly name: string;
  readonly signer: string;
  readonly request: SignRequest & { readonly message?: { readonly $bytes: string } };
  readonly expect: {
    readonly prompt: Readonly<Record<"en" | "zh-Hans", string>>;
  };
};

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/fiat24.json"), "utf8"),
) as { cases: ReadonlyArray<VectorCase> };

const request = (v: VectorCase): SignRequest =>
  v.request.message?.$bytes === undefined
    ? v.request
    : ({
        ...v.request,
        message: hexToBytes(v.request.message.$bytes.replace(/^0x/, "")),
      } as SignRequest);

const split = (s: string): { title: string; description: string } => {
  const i = s.indexOf("\n");
  return { title: s.slice(0, i), description: s.slice(i + 1) };
};

describe("Fiat24 vectors", () => {
  it.each(vectors.cases)("$name", (v) => {
    const intent = decodeEvm(request(v), v.signer);
    expect(chainPrompt("en", intent)).toStrictEqual(split(v.expect.prompt.en));
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual(split(v.expect.prompt["zh-Hans"]));
  });
});
