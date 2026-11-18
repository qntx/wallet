import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";
import { decodeEvm } from "@qntx/wallet-chains/evm";

import { chainPrompt } from "../src/modules/chains/prompt.ts";
import type { KeystorePrompt } from "../src/platform.ts";

type VectorCase = {
  readonly name: string;
  readonly request: SignRequest & {
    readonly message?: { readonly $bytes: string };
    readonly typedData?: unknown;
  };
  readonly prompt: Readonly<Record<"en" | "zh-Hans", KeystorePrompt>>;
};

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/signing-classes.json"),
    "utf8",
  ),
) as { signer: string; cases: VectorCase[] };

const request = (v: VectorCase): SignRequest => {
  if (v.request.kind === "evm.personal-message") {
    return { ...v.request, message: hexToBytes(v.request.message.$bytes.slice(2)) };
  }
  if (v.request.kind === "evm.typed-data") {
    return { ...v.request, typedData: JSON.stringify(v.request.typedData) };
  }
  return v.request;
};

describe("signing-classes vectors", () => {
  it.each(vectors.cases)("$name", (v) => {
    const intent = decodeEvm(request(v), vectors.signer);
    expect(chainPrompt("en", intent)).toStrictEqual(v.prompt.en);
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual(v.prompt["zh-Hans"]);
  });
});
