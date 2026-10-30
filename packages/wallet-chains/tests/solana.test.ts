import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { getU32Encoder, getU64Encoder } from "@solana/codecs";
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  getCompiledTransactionMessageEncoder,
} from "@solana/transaction-messages";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import { PROGRAM_IDS } from "../src/solana/ids.ts";
import {
  decodeSolana,
  isSolanaAddress,
  normalizeSolana,
  verifiabilitySolana,
} from "../src/solana/index.ts";
import { signSolanaMessage } from "../src/solana/sign.ts";
import type { SolanaTokenTable } from "../src/solana/tokens.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
) as { mnemonic: string };

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes: Uint8Array): string => {
  let n = 0n;
  for (const b of bytes) {
    n = n * 256n + BigInt(b);
  }
  let s = "";
  while (n > 0n) {
    s = BASE58_ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros++;
  }
  return "1".repeat(zeros) + s;
};

const slip10 = (seed: Uint8Array, path: ReadonlyArray<number>): Uint8Array => {
  let hmacOut = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let chain = hmacOut.slice(32);
  let node = hmacOut.slice(0, 32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(node, 1);
    const idx = index + 0x80000000;
    data[33] = Math.floor(idx / 16777216);
    data[34] = Math.floor(idx / 65536) % 256;
    data[35] = Math.floor(idx / 256) % 256;
    data[36] = idx % 256;
    hmacOut = hmac(sha512, chain, data);
    chain = hmacOut.slice(32);
    node = hmacOut.slice(0, 32);
  }
  return node;
};

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FEE_PAYER = "11111111111111111111111111111112";
const DEST = "11111111111111111111111111111113";
const BLOCKHASH = b58(new Uint8Array(32).fill(9));
const u32 = getU32Encoder();
const u64 = getU64Encoder();

const instruction = (
  programAddress: string,
  accounts: Array<{ address: string; role: number }>,
  data: Uint8Array,
) => ({
  programAddress: programAddress as never,
  accounts,
  data,
});

const compile = (
  instructions: ReadonlyArray<{
    programAddress: string;
    accounts: Array<{ address: string; role: number }>;
    data: Uint8Array;
  }>,
  version: "legacy" | 0 = "legacy",
): Uint8Array => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(FEE_PAYER as never, createTransactionMessage({ version })),
  );
  for (const ix of instructions) {
    message = appendTransactionMessageInstruction(ix as never, message as never);
  }
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
  );
};

const transferIx = () => {
  const data = new Uint8Array(12);
  data.set(u32.encode(2), 0);
  data.set(u64.encode(1000n), 4);
  return instruction(
    PROGRAM_IDS.system,
    [
      { address: FEE_PAYER, role: 3 },
      { address: DEST, role: 1 },
    ],
    data,
  );
};

const req = (message: Uint8Array) => ({
  kind: "solana.transaction",
  network: MAINNET,
  account: ACCOUNT,
  message,
});

describe("addresses + derivation", () => {
  it("derives a valid ed25519 address via SLIP-10", () => {
    const seed = mnemonicToSeedSync(vectors.mnemonic);
    const node = slip10(seed, [44, 501, 0, 0]);
    expect(isSolanaAddress(b58(ed25519.getPublicKey(node)))).toBe(true);
  });

  it("validates base58 addresses", () => {
    expect(isSolanaAddress(FEE_PAYER)).toBe(true);
    expect(isSolanaAddress("0x1234")).toBe(false);
  });
});

describe("sign", () => {
  const seed = new Uint8Array(32).fill(7);
  const message = Uint8Array.from(Buffer.from("hello solana"));

  it("produces a verifiable 64-byte signature matching Node crypto", () => {
    const ours = signSolanaMessage(message, seed);
    expect(ours).toHaveLength(64);
    expect(ed25519.verify(ours, message, ed25519.getPublicKey(seed))).toBe(true);
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(seed),
    ]);
    const node = sign(null, Buffer.from(message), { key: pkcs8, format: "der", type: "pkcs8" });
    expect(Buffer.from(ours).equals(node)).toBe(true);
  });

  it("rejects wrong-length inputs", () => {
    expect(() => signSolanaMessage(message, new Uint8Array(31))).toThrow(ChainError);
    expect(() => signSolanaMessage(new Uint8Array(0), seed)).toThrow(ChainError);
  });
});

describe("normalize", () => {
  it("accepts a compiled system-transfer message", () => {
    const n = normalizeSolana(req(compile([transferIx()])), FEE_PAYER);
    expect(n.kind).toBe("solana.transaction");
  });

  it("rejects a fee-payer mismatch", () => {
    expect(() => normalizeSolana(req(compile([transferIx()])), DEST)).toThrow(ChainError);
  });

  it("rejects >1232-byte and non-message payloads", () => {
    expect(() => normalizeSolana(req(new Uint8Array(1233)), FEE_PAYER)).toThrow(ChainError);
    expect(() => normalizeSolana(req(new Uint8Array(3)), FEE_PAYER)).toThrow(ChainError);
  });

  it("rejects unknown networks", () => {
    const bad = { ...req(compile([transferIx()])), network: "solana:unknown" };
    expect(() => normalizeSolana(bad, FEE_PAYER)).toThrow(ChainError);
  });

  it("rejects solana.message bytes that decode as a transaction", () => {
    const asMessage = { ...req(compile([transferIx()])), kind: "solana.message", format: "raw" };
    expect(() => normalizeSolana(asMessage, FEE_PAYER)).toThrow(ChainError);
    const raw = normalizeSolana(
      { ...asMessage, message: Uint8Array.from(Buffer.from("not a tx")) },
      FEE_PAYER,
    );
    expect(raw.kind).toBe("solana.message");
  });
});

describe("verifiability + decode", () => {
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const table: SolanaTokenTable = { [MAINNET]: { [MINT]: { symbol: "USDC", decimals: 6 } } };

  it("system transfer → full", () => {
    const intent = decodeSolana(req(compile([transferIx()])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("full");
    expect(intent.outflows[0]?.amount.amount).toBe("1000");
  });

  it("unknown program → opaque", () => {
    const ix = instruction("Vote111111111111111111111111111111111111111", [], new Uint8Array([1]));
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("opaque");
  });

  it("system createAccount (non-transfer) → opaque", () => {
    const data = new Uint8Array(52);
    data.set(u32.encode(0), 0);
    const ix = instruction(
      PROGRAM_IDS.system,
      [
        { address: FEE_PAYER, role: 3 },
        { address: DEST, role: 1 },
      ],
      data,
    );
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("opaque");
  });

  it("transferChecked → full in the table, partial without", () => {
    const data = new Uint8Array(10);
    data[0] = 12;
    data.set(u64.encode(50n), 1);
    data[9] = 6;
    const ix = instruction(
      PROGRAM_IDS.token,
      [
        { address: "srcTokenAcct1111111111111111111111111111111", role: 0 },
        { address: MINT, role: 0 },
        { address: "dstTokenAcct1111111111111111111111111111111", role: 1 },
        { address: FEE_PAYER, role: 2 },
      ],
      data,
    );
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER, table)).toBe("full");
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER, {})).toBe("partial");
  });

  it("token approve → partial; stake → partial", () => {
    const approve = new Uint8Array(9);
    approve[0] = 4;
    approve.set(u64.encode(5n), 1);
    const ix = instruction(PROGRAM_IDS.token, [{ address: FEE_PAYER, role: 3 }], approve);
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("partial");
    const stakeIx = instruction(PROGRAM_IDS.stake, [], new Uint8Array(4));
    expect(verifiabilitySolana(req(compile([stakeIx])) as never, FEE_PAYER)).toBe("partial");
  });

  it("compute-budget pair sets the fee ceiling", () => {
    const limit = new Uint8Array(5);
    limit[0] = 2;
    limit.set(u32.encode(200000), 1);
    const price = new Uint8Array(9);
    price[0] = 3;
    price.set(u64.encode(1000n), 1);
    const ixL = instruction(PROGRAM_IDS.computeBudget, [], limit);
    const ixP = instruction(PROGRAM_IDS.computeBudget, [], price);
    const intent = decodeSolana(req(compile([ixL, ixP, transferIx()])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("full");
    expect(intent.fee?.max.amount).toBe("5200");
  });
});
