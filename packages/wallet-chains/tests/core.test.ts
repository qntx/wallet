import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "../src/index.ts";
import { decodeCoreIx } from "../src/solana/core.ts";
import { decodeSolana } from "../src/solana/decode.ts";
import { parseCompiledMessage } from "../src/solana/message.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
) as {
  core: Array<{
    name: string;
    message: string;
    lookupTables: Array<{ address: string; addresses: string[] }>;
    expected: { summary: string; verifiability: string; outflows: unknown[] };
  }>;
};

const AUTHORITY = "62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const req = (
  message: string,
  lookups: ReadonlyArray<{ address: string; addresses: string[] }> = [],
): SignRequest => ({
  kind: "solana.transaction" as const,
  network: NETWORK,
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "solana.bip44" },
  message: Uint8Array.from(Buffer.from(message.slice(2), "hex")),
  lookupTables: lookups.map((t) => ({ address: t.address, addresses: t.addresses })),
});

describe("metaplex core decode", () => {
  it.each(vectors.core.map((v) => [v.name, v] as const))(
    "%s decodes to the expected intent",
    (_name, v) => {
      const intent = decodeSolana(req(v.message, v.lookupTables), AUTHORITY);
      expect(intent.summary).toBe(v.expected.summary);
      expect(intent.verifiability).toBe(v.expected.verifiability);
      expect(intent.outflows).toStrictEqual(v.expected.outflows);
    },
  );

  it("an authority that is not the signer is opaque", () => {
    const intent = decodeSolana(req(vectors.core[0]!.message), "11111111111111111111111111111111");
    expect(intent.summary).not.toBe("transfer");
  });

  it("a compression-proof transfer is not recognised", () => {
    const parsed = parseCompiledMessage(Uint8Array.from(Buffer.from(vectors.core[0]!.message.slice(2), "hex")));
    const ix = parsed.instructions[0]!;
    /* Mutate the args byte from 0 (None) to 1 (Some proof) — the layout is then a proof blob. */
    const core = decodeCoreIx(
      parsed,
      { accountIndices: ix.accountIndices, data: Uint8Array.from([14, 1]) },
      [],
    );
    expect(core).toBeUndefined();
  });

  it("an unknown core instruction is opaque", () => {
    const parsed = parseCompiledMessage(Uint8Array.from(Buffer.from(vectors.core[0]!.message.slice(2), "hex")));
    const ix = parsed.instructions[0]!;
    const core = decodeCoreIx(
      parsed,
      { accountIndices: ix.accountIndices, data: Uint8Array.from([12, 0]) },
      [],
    );
    expect(core).toBeUndefined();
  });
});
