import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { findAssociatedTokenPda } from "@solana-program/token";
import { address } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { associatedTokenAddress } from "../src/solana/ata.ts";
import { decodeSolana } from "../src/solana/decode.ts";
import { PROGRAM_IDS } from "../src/solana/ids.ts";
import { WSOL_MINT } from "../src/solana/jupiter.ts";

const SIGNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
) as {
  jupiter: Array<{
    name: string;
    message: string;
    lookupTables?: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }>;
    expected: {
      summary: string;
      verifiability: string;
      outflows: unknown[];
      minimumReceived: unknown[];
    };
  }>;
};

const req = (message: Uint8Array, lookupTables?: unknown) =>
  ({
    kind: "solana.transaction",
    network: MAINNET,
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44" },
    message,
    lookupTables,
  }) as never;

const hex = (h: string): Uint8Array =>
  Uint8Array.from(Buffer.from(h.startsWith("0x") ? h.slice(2) : h, "hex"));

describe("associatedTokenAddress", () => {
  it.each([
    [SIGNER, WSOL_MINT, PROGRAM_IDS.token],
    [SIGNER, USDC, PROGRAM_IDS.token],
    ["Ff4CgHQXyMBRktUtmCNPvL4YS1NBiS1d9QDrPqRMhLQ", USDC, PROGRAM_IDS.token],
    [SIGNER, USDC, PROGRAM_IDS.token2022],
  ])("derives %s/%s/%s like findAssociatedTokenPda", async (owner, mint, program) => {
    const [expected] = await findAssociatedTokenPda({
      owner: address(owner),
      mint: address(mint),
      tokenProgram: address(program),
    });
    expect(associatedTokenAddress(owner, mint, program)).toBe(expected);
  });
});

describe("jupiter decode", () => {
  const vector = vectors.jupiter[0]!;
  const decode = () => decodeSolana(req(hex(vector.message), vector.lookupTables), SIGNER);

  it("the real /build v0 message decodes to the expected swap", () => {
    const intent = decode();
    expect(intent.summary).toBe(vector.expected.summary);
    expect(intent.verifiability).toBe(vector.expected.verifiability);
    expect(intent.outflows).toStrictEqual(vector.expected.outflows);
    expect(intent.minimumReceived).toStrictEqual(vector.expected.minimumReceived);
    expect(intent.warnings).toStrictEqual([]);
  });

  it("a wrapped transfer to the signer's own wSOL ATA is not an outflow", () => {
    expect(
      (decode().outflows as ReadonlyArray<{ to: string }>).some(
        (o) => o.to === "8LjUgMjzZuHj8VdyxzkmLLQVmW4C3gd56md1nLd76TNW",
      ),
    ).toBe(false);
  });

  it("a malformed message is rejected, and the same bytes for another signer are opaque", () => {
    const v = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
    ) as { jupiter: Array<{ message: string; lookupTables?: unknown }> };
    const bytes = hex(v.jupiter[0]!.message);
    expect(() =>
      decodeSolana(req(bytes.slice(0, -20), v.jupiter[0]!.lookupTables), SIGNER),
    ).toThrow();
    const foreign = decodeSolana(
      req(bytes, v.jupiter[0]!.lookupTables),
      "Ff4CgHQXyMBRktUtmCNPvL4YS1NBiS1d9QDrPqRMhLQ",
    );
    expect(foreign.verifiability).toBe("opaque");
  });
});
