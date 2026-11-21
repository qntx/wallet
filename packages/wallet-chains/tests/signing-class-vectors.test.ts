import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { isBlindIntent, messageBlindReason, messageContent } from "../src/index.ts";
import type { DisplayIntent, SignRequest } from "../src/index.ts";
import { decodeSolana } from "../src/solana/index.ts";
import { decodeTron } from "../src/tron/decode.ts";

type VectorCase = {
  readonly name: string;
  readonly request: SignRequest & {
    readonly message?: { readonly $bytes: string };
    readonly rawData?: { readonly $bytes: string };
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
) as { signers: { evm: string; tron: string; solana: string }; cases: VectorCase[] };

/** Rehydrates the JSON-only request forms (`$bytes`, parsed typed-data doc). */
const request = (v: VectorCase): SignRequest => {
  if (
    v.request.kind === "evm.personal-message" ||
    v.request.kind === "tron.message" ||
    v.request.kind === "solana.transaction" ||
    v.request.kind === "solana.message"
  ) {
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

/** The decoder and signer for the request's family. */
const familyOf = (
  kind: string,
): {
  decode: (request: SignRequest, signer: string) => DisplayIntent;
  signer: string;
} =>
  kind.startsWith("tron.")
    ? { decode: decodeTron, signer: vectors.signers.tron }
    : kind === "solana.message"
      ? {
          // `decodeSolana` is transaction-only; a raw message's display is the
          // content classification plus its blind reason, as in decodeTron.
          decode: (r) => {
            const { message, network } = r as Extract<SignRequest, { kind: "solana.message" }>;
            const content = messageContent(message, "solana");
            const blind = messageBlindReason(content);
            return {
              family: "solana",
              network,
              summary: "message",
              outflows: [],
              approvals: [],
              fee: undefined,
              warnings: [],
              message: content,
              verifiability: "opaque",
              ...(blind === undefined ? {} : { blind }),
            };
          },
          signer: vectors.signers.solana,
        }
      : kind.startsWith("solana.")
        ? {
            decode: (r, s) =>
              decodeSolana(r as Extract<SignRequest, { kind: "solana.transaction" }>, s),
            signer: vectors.signers.solana,
          }
        : { decode: decodeEvm, signer: vectors.signers.evm };

const blindOf = (intent: DisplayIntent): string | null => intent.blind ?? null;

describe("signing-classes vectors", () => {
  it("names every case uniquely", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    expect(new Set(vectors.cases.map((v) => v.name)).size).toBe(vectors.cases.length);
  });

  it.each(vectors.cases)("$name", (v) => {
    const { decode, signer } = familyOf(v.request.kind);
    const intent = decode(request(v), signer);
    expect(intent.verifiability).toBe(v.verifiability);
    expect(blindOf(intent)).toBe(v.blind);
    expect(isBlindIntent(intent)).toBe(v.blind !== null);
  });
});
