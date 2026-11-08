import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { findAssociatedTokenPda } from "@solana-program/token";
import type { AddressesByLookupTableAddress } from "@solana/kit";
import {
  AccountRole,
  appendTransactionMessageInstruction,
  address,
  blockhash,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { associatedTokenAddress } from "../src/solana/ata.ts";
import { decodeSolana } from "../src/solana/decode.ts";
import { PROGRAM_IDS } from "../src/solana/ids.ts";
import { WSOL_MINT } from "../src/solana/jupiter.ts";
import { parseCompiledMessage, resolveAccountIndex } from "../src/solana/message.ts";

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
    ).toThrow("compiled message failed to decode");
    const foreign = decodeSolana(
      req(bytes, v.jupiter[0]!.lookupTables),
      "Ff4CgHQXyMBRktUtmCNPvL4YS1NBiS1d9QDrPqRMhLQ",
    );
    expect(foreign.verifiability).toBe("opaque");
  });
});

describe("resolveAccountIndex with multiple lookup tables", () => {
  it("resolves writable-from-table-2 and readonly-from-table-1 in v0 order", async () => {

    const TABLE1 = "GcUy7n96V4CLEupSJGAd2KbkR2bpmEfrBxpCzqy4Sfcr";
    const TABLE2 = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";
    const W2 = "6wWVbLeHDVHvCCsLprB85jkbU1JhS9VezABT2ZZFJ5BB";
    const R1 = "7bFrELm2JUsKfjghdHRXo75ZzQwKWATMLreP5QSnKLcE";
    const OTHER1 = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
    const OTHER2 = "9Y34Wev18pdowy32Akobj4JpWWko4JhzhvoyzJNrX94v";
    const tables: Record<string, string[]> = {
      [TABLE1]: [R1, OTHER1, "FsoYiVQ9vKFnX9tpNi7d6N8Ptk8HQbnmednRzdmmURp4"],
      [TABLE2]: ["CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8", W2, OTHER2],
    };
    const payer = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    /* One synthetic instruction whose accounts span both tables: [payer, W2 (table2 writable),
       R1 (table1 readonly)] — the program id itself is static. */
    const msg = appendTransactionMessageInstruction(
      {
        programAddress: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        accounts: [
          { address: address(W2), role: AccountRole.WRITABLE },
          { address: address(R1), role: AccountRole.READONLY },
        ],
        data: Uint8Array.from([9]),
      },
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n },
        setTransactionMessageFeePayer(
          address(payer),
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    const lookupsByTable: AddressesByLookupTableAddress = Object.fromEntries(
      Object.entries(tables).map(([k, v]) => [address(k), v.map(address)]),
    );
    const compressed = compressTransactionMessageUsingAddressLookupTables(msg, lookupsByTable);
    const compiled = compileTransactionMessage(compressed);
    const bytes = new Uint8Array(getCompiledTransactionMessageEncoder().encode(compiled));
    /* The kit's compressor placed each account into its table's writable or readonly slot;
       resolving those indices through the declared contents must give the original addresses —
       wrong slot ordering lands on a different table's entries. */
    const parsed = parseCompiledMessage(bytes);
    const declared = Object.entries(tables).map(([a, addresses]) => ({ address: a, addresses }));
    const ix = parsed.instructions[0]!;
    expect(resolveAccountIndex(parsed, ix.accountIndices[0]!, declared)).toBe(W2);
    expect(resolveAccountIndex(parsed, ix.accountIndices[1]!, declared)).toBe(R1);
    /* Missing table → the instruction cannot resolve its accounts → the intent is opaque. */
    const intent = decodeSolana(req(bytes, declared.slice(0, 1)), payer);
    expect(intent.verifiability).toBe("opaque");
  });
});
