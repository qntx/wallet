import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { DisplayIntent, SignRequest } from "@qntx/wallet-chains";
import { decodeEvm } from "@qntx/wallet-chains/evm";
import { decodeTron } from "@qntx/wallet-chains/tron";

import { chainPrompt } from "../src/modules/chains/prompt.ts";
import type { KeystorePrompt } from "../src/platform.ts";

type VectorCase = {
  readonly name: string;
  readonly request: SignRequest & {
    readonly message?: { readonly $bytes: string };
    readonly rawData?: { readonly $bytes: string };
    readonly typedData?: unknown;
  };
  readonly prompt: Readonly<Record<"en" | "zh-Hans", KeystorePrompt>>;
};

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/signing-classes.json"),
    "utf8",
  ),
) as { signers: { evm: string; tron: string }; cases: VectorCase[] };

const request = (v: VectorCase): SignRequest => {
  if (v.request.kind === "evm.personal-message" || v.request.kind === "tron.message") {
    return {
      ...v.request,
      message: hexToBytes(v.request.message.$bytes.replace(/^0x/, "")),
    };
  }
  if (v.request.kind === "evm.typed-data") {
    return { ...v.request, typedData: JSON.stringify(v.request.typedData) };
  }
  if (v.request.kind === "tron.transaction") {
    return { ...v.request, rawData: hexToBytes(v.request.rawData.$bytes.replace(/^0x/, "")) };
  }
  return v.request;
};

const intentOf = (v: VectorCase): DisplayIntent =>
  v.request.kind.startsWith("tron.")
    ? decodeTron(request(v), vectors.signers.tron)
    : decodeEvm(request(v), vectors.signers.evm);

describe("signing-classes vectors", () => {
  it.each(vectors.cases)("$name", (v) => {
    const intent = intentOf(v);
    expect(chainPrompt("en", intent)).toStrictEqual(v.prompt.en);
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual(v.prompt["zh-Hans"]);
  });
});
