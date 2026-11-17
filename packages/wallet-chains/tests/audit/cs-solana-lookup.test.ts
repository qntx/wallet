/**
 * Audit A1 / chains-signing PoC: a v0 SOL transfer whose recipient sits in an address lookup table.
 * The amount and the source (the signer, a static account) are fully decodable from the message,
 * but when the untrusted host omits or falsifies `lookupTables` the decoder drops the whole
 * outflow — the prompt then shows no amount at all.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { getTransferSolInstruction } from "@solana-program/system";
import { address } from "@solana/addresses";
import { createNoopSigner } from "@solana/kit";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import { describe, expect, it } from "vite-plus/test";

import { decodeSolana, normalizeSolana } from "../../src/solana/index.ts";
import { associatedTokenAddress } from "../../src/solana/ata.ts";
import { PROGRAM_IDS, solanaAddressFromPublicKey } from "../../src/solana/ids.ts";
import { WSOL_MINT } from "../../src/solana/jupiter.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" } as const;
const signer = solanaAddressFromPublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const recipient = solanaAddressFromPublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const TABLE = solanaAddressFromPublicKey(ed25519.getPublicKey(new Uint8Array(32).fill(5)));

const message = (): Uint8Array => {
  let m: unknown = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as never, lastValidBlockHeight: 1n },
    setTransactionMessageFeePayer(address(signer), createTransactionMessage({ version: 0 })),
  );
  m = appendTransactionMessageInstruction(
    getTransferSolInstruction({
      source: createNoopSigner(address(signer)),
      destination: address(recipient),
      amount: 100_000_000_000n,
    }) as never,
    m as never,
  );
  const compressed = compressTransactionMessageUsingAddressLookupTables(m as never, {
    [TABLE]: [address(recipient)],
  } as never);
  return new Uint8Array(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(compressed)));
};

const decode = (lookupTables?: ReadonlyArray<{ address: string; addresses: string[] }>) =>
  decodeSolana(
    normalizeSolana(
      {
        kind: "solana.transaction",
        network: NETWORK,
        account: ACCOUNT,
        message: message(),
        ...(lookupTables === undefined ? {} : { lookupTables }),
      },
      signer,
    ) as never,
    signer,
  );

describe("CS-SOL-ALT: a lookup-resolved recipient drops a 100 SOL outflow", () => {
  it("with the honest table the 100 SOL transfer is shown", () => {
    const intent = decode([{ address: TABLE, addresses: [recipient] }]);
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows.map((o) => o.amount.amount)).toStrictEqual(["100000000000"]);
  });

  it("with the table omitted the outflow disappears", () => {
    const intent = decode();
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([]);
    expect(intent.summary).toBe("contract-call");
  });

  it("with a falsified table naming the signer's wSOL ATA the outflow disappears as 'wrapping'", () => {
    const wsol = associatedTokenAddress(signer, WSOL_MINT, PROGRAM_IDS.token);
    const intent = decode([{ address: TABLE, addresses: [wsol] }]);
    expect(intent.outflows).toStrictEqual([]);
  });
});
