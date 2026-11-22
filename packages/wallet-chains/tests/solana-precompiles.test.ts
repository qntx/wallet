/**
 * Solana precompile fixtures: real mainnet transactions invoking the signature-verification
 * precompiles, re-fetched from the public RPC by scripts/vectors/solana-precompiles.ts. Decoding as
 * the fee payer, the shown Max fee must cover what the cluster actually charged (meta.fee), and its
 * signature component must equal 5000 × (required signatures + the precompile signatures counted
 * from the RPC's instruction data by the generator).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { PROGRAM_IDS } from "../src/solana/ids.ts";
import { decodeSolana, parseCompiledMessage } from "../src/solana/index.ts";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;

type Fixture = {
  readonly label: string;
  readonly precompile: string;
  readonly signature: string;
  readonly slot: number;
  readonly version: "legacy" | 0 | 1;
  readonly feePayer: string;
  readonly fee: number;
  readonly precompileSignatures: number;
  readonly priorityFeeBound: string;
  readonly message: string;
  readonly lookupTables?: ReadonlyArray<{
    readonly address: string;
    readonly addresses: ReadonlyArray<string>;
  }>;
};

const fixtures = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/solana-precompiles.json"),
    "utf8",
  ),
) as Fixture[];

type LookupTable = { readonly address: string; readonly addresses: ReadonlyArray<string> };

const tables = (fixture: Fixture): LookupTable[] => [...(fixture.lookupTables ?? [])];

const maxFee = (intent: ReturnType<typeof decodeSolana>): bigint =>
  BigInt(intent.fee?.max.amount ?? "0");

describe("solana precompile fixtures bound the real fee", () => {
  it("covers every signature-verification precompile", () => {
    const seen = new Set(fixtures.map((f) => f.precompile));
    for (const id of [PROGRAM_IDS.ed25519, PROGRAM_IDS.secp256k1, PROGRAM_IDS.secp256r1]) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it.each(fixtures)("$label $signature", (fixture) => {
    const message = Uint8Array.from(Buffer.from(fixture.message, "base64"));
    const parsed = parseCompiledMessage(message);
    expect(parsed.version).toBe(fixture.version);
    const intent = decodeSolana(
      {
        kind: "solana.transaction",
        network: MAINNET,
        account: ACCOUNT,
        message,
        lookupTables: tables(fixture),
      },
      fixture.feePayer,
    );
    const max = maxFee(intent);
    const signatures =
      5000n * (BigInt(parsed.numRequiredSignatures) + BigInt(fixture.precompileSignatures));
    expect(max - signatures).toBe(BigInt(fixture.priorityFeeBound));
    expect(max).toBeGreaterThanOrEqual(BigInt(fixture.fee));
  });
});
