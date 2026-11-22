/**
 * Vectors/chains/solana-v1.json through the kernel: each valid v1 message must render the pinned
 * en/zh-Hans prompt via `chainPrompt(decodeSolana(normalizeSolana(...)))` — the same pipeline the
 * kernel uses — and the kernel's Solana signer must reproduce the recorded signature byte for byte.
 * Malformed frames are refused at normalize.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "@qntx/wallet-chains";
import { decodeSolana, normalizeSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { signSolanaMessage } from "@qntx/wallet-chains/solana/sign";

import { chainPrompt } from "../src/modules/chains/prompt.ts";

const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

const WALLET_SEED = new Uint8Array(32).fill(0x07);

type Prompt = { readonly title: string; readonly description: string };
type Valid = {
  readonly name: string;
  readonly message: string;
  readonly wire: string;
  readonly signature: string;
  readonly signer: string;
  readonly verifiability: string;
  readonly blind: string | null;
  readonly prompt: { readonly en: Prompt; readonly "zh-Hans": Prompt };
};
type Malformed = {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly rule: string;
};
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana-v1.json"), "utf8"),
) as {
  readonly network: string;
  readonly account: { readonly kind: string };
  readonly cases: ReadonlyArray<Valid>;
  readonly malformed: ReadonlyArray<Malformed>;
};

const request = (c: Valid): Record<string, unknown> => ({
  kind: "solana.transaction",
  network: vectors.network,
  account: vectors.account,
  message: unhex(c.message),
});
const firstCase = vectors.cases[0]!;

describe("solana-v1 vectors through the kernel pipeline", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    "%s renders the pinned prompt in en and zh-Hans",
    (_name, c) => {
      const normalized = normalizeSolana(request(c), c.signer);
      const intent = decodeSolana(normalized as never, c.signer);
      expect(intent.verifiability).toBe(c.verifiability);
      expect(chainPrompt("en", intent)).toStrictEqual(c.prompt.en);
      expect(chainPrompt("zh-Hans", intent)).toStrictEqual(c.prompt["zh-Hans"]);
    },
  );

  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    "%s signs byte-for-byte like the vector and verifies",
    (_name, c) => {
      const message = unhex(c.message);
      expect(signSolanaMessage(message, WALLET_SEED)).toStrictEqual(unhex(c.signature));
      expect(verifySolanaSignature(message, unhex(c.signature), c.signer)).toBe(true);
    },
  );

  it.each(vectors.malformed.map((m) => [m.name, m] as const))(
    "malformed %s is refused at normalize",
    (_name, m) => {
      expect(() =>
        normalizeSolana({ ...request(firstCase), message: unhex(m.message) }, firstCase.signer),
      ).toThrow(ChainError);
    },
  );
});
