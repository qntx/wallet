import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getDelegateStakeInstruction } from "@solana-program/stake";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  getApproveInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getCreateAssociatedTokenInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { getTransferCheckedInstruction as getTransferCheckedInstruction2022 } from "@solana-program/token-2022";
import { address, getAddressDecoder } from "@solana/addresses";
import { assertIsSignatureBytes, createNoopSigner, verifySignature } from "@solana/kit";
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

import { ChainError } from "../src/index.ts";
import {
  decodeSolana,
  isSolanaAddress,
  normalizeSolana,
  verifiabilitySolana,
} from "../src/solana/index.ts";
import { signSolanaMessage } from "../src/solana/sign.ts";
import type { SolanaTokenTable } from "../src/solana/tokens.ts";

type Slip10Vector = {
  path: string;
  indices: ReadonlyArray<number>;
  privateKey: string;
  publicKey: string;
};

type SolanaVectors = {
  mnemonic: string;
  slip10: { seed: string; vectors: ReadonlyArray<Slip10Vector> };
  derivationPath: string;
  addresses: ReadonlyArray<string>;
  networks: ReadonlyArray<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSlip10Vector = (v: unknown): v is Slip10Vector =>
  isRecord(v) &&
  typeof v["path"] === "string" &&
  Array.isArray(v["indices"]) &&
  (v["indices"] as ReadonlyArray<unknown>).every((i) => typeof i === "number") &&
  typeof v["privateKey"] === "string" &&
  typeof v["publicKey"] === "string";

const readVectors = (): SolanaVectors => {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
  );
  if (
    !isRecord(raw) ||
    typeof raw["mnemonic"] !== "string" ||
    typeof raw["derivationPath"] !== "string" ||
    !isRecord(raw["slip10"])
  ) {
    throw new Error("malformed solana vectors file");
  }
  const slip10v = raw["slip10"];
  if (
    typeof slip10v["seed"] !== "string" ||
    !Array.isArray(slip10v["vectors"]) ||
    !slip10v["vectors"].every(isSlip10Vector) ||
    !Array.isArray(raw["addresses"]) ||
    !raw["addresses"].every((a) => typeof a === "string") ||
    !Array.isArray(raw["networks"]) ||
    !raw["networks"].every((n) => typeof n === "string")
  ) {
    throw new Error("malformed solana vectors file");
  }
  return {
    mnemonic: raw["mnemonic"],
    derivationPath: raw["derivationPath"],
    slip10: { seed: slip10v["seed"], vectors: slip10v["vectors"] },
    addresses: raw["addresses"],
    networks: raw["networks"],
  };
};

const vectors = readVectors();

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex"));

const addressDecoder = getAddressDecoder();

/** SLIP-10 ed25519 derivation — test-only, noble hmac/sha512, hardened steps only. */
const slip10 = (seed: Uint8Array, path: ReadonlyArray<number>): Uint8Array => {
  let hmacOut = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let chain = hmacOut.slice(32);
  let node = hmacOut.slice(0, 32);
  for (const index of path) {
    const data = new Uint8Array(37);
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
const FEE_PAYER = address("11111111111111111111111111111112");
const DEST = address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
const ATA = address("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8");
const MINT = address("GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq");
const SRC_TOKEN = address("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");
const DST_TOKEN = address("QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF");
const DELEGATE = address("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
const STAKE_ACCT = address("YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf");
const VOTE_ACCT = address("cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN");
const BLOCKHASH = address("11111111111111111111111111111111");
const LOOKUP_TABLE = address("AddressLookupTab1e1111111111111111111111111");

const compile = (
  instructions: ReadonlyArray<unknown>,
  version: "legacy" | 0 = "legacy",
  lookupAddresses?: Record<string, ReadonlyArray<string>>,
): Uint8Array => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(FEE_PAYER, createTransactionMessage({ version })),
  );
  for (const ix of instructions) {
    message = appendTransactionMessageInstruction(ix as never, message as never);
  }
  if (lookupAddresses !== undefined && version === 0) {
    const compressed = compressTransactionMessageUsingAddressLookupTables(
      message as never,
      lookupAddresses as never,
    );
    return new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(compressed)),
    );
  }
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
  );
};

const feePayerSigner = createNoopSigner(FEE_PAYER);

const transferIx = () =>
  getTransferSolInstruction({ source: feePayerSigner, destination: DEST, amount: 1000n });

const req = (message: Uint8Array) => ({
  kind: "solana.transaction",
  network: MAINNET,
  account: ACCOUNT,
  message,
});

describe("derivation + addresses", () => {
  it.each(vectors.slip10.vectors)(
    "SLIP-10 ed25519 vector $path matches the spec",
    ({ indices, privateKey, publicKey }) => {
      const node = slip10(hexToBytes(vectors.slip10.seed), indices);
      expect(Buffer.from(node).toString("hex")).toBe(privateKey.slice(2));
      expect(Buffer.from(ed25519.getPublicKey(node)).toString("hex")).toBe(publicKey.slice(2));
    },
  );

  it.each(vectors.addresses.map((expected, index) => ({ expected, index })))(
    "test-mnemonic account $index at m/44'/501'/$index'/0'",
    ({ expected, index }) => {
      const seed = mnemonicToSeedSync(vectors.mnemonic);
      const node = slip10(seed, [44, 501, index, 0]);
      expect(addressDecoder.decode(ed25519.getPublicKey(node))).toBe(expected);
    },
  );

  it("validates base58 addresses", () => {
    expect(isSolanaAddress(FEE_PAYER)).toBe(true);
    expect(isSolanaAddress("0x1234")).toBe(false);
  });
});

describe("sign", () => {
  const seed = new Uint8Array(32).fill(7);
  const message = Uint8Array.from(Buffer.from("hello solana"));

  it("matches Node crypto.sign and verifies with @solana/kit", async () => {
    const ours = signSolanaMessage(message, seed);
    expect(ours).toHaveLength(64);
    const pub = ed25519.getPublicKey(seed);
    expect(ed25519.verify(ours, message, pub)).toBe(true);
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(seed),
    ]);
    const node = sign(null, Buffer.from(message), { key: pkcs8, format: "der", type: "pkcs8" });
    expect(Buffer.from(ours).equals(node)).toBe(true);
    const key = await crypto.subtle.importKey("raw", pub, "Ed25519", true, ["verify"]);
    assertIsSignatureBytes(ours);
    await expect(verifySignature(key, ours, message)).resolves.toBe(true);
  });

  it("rejects wrong-length inputs", () => {
    expect(() => signSolanaMessage(message, new Uint8Array(31))).toThrow(ChainError);
    expect(() => signSolanaMessage(new Uint8Array(0), seed)).toThrow(ChainError);
  });
});

describe("normalize", () => {
  it("accepts a compiled system-transfer message (legacy and v0)", () => {
    for (const version of ["legacy", 0] as const) {
      const n = normalizeSolana(req(compile([transferIx()], version)), FEE_PAYER);
      expect(n.kind).toBe("solana.transaction");
    }
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

  it("rejects a non-raw solana.message format", () => {
    const bad = { ...req(new Uint8Array([1, 2, 3])), kind: "solana.message", format: "offchain" };
    expect(() => normalizeSolana(bad, FEE_PAYER)).toThrow(ChainError);
  });
});

describe("verifiability + decode", () => {
  const table: SolanaTokenTable = {
    [MAINNET]: { [MINT]: { symbol: "USDC", decimals: 6 } },
  };

  it("System transfer → full with a lamports outflow (legacy and v0)", () => {
    for (const version of ["legacy", 0] as const) {
      const intent = decodeSolana(req(compile([transferIx()], version)) as never, FEE_PAYER);
      expect(intent.verifiability).toBe("full");
      expect(intent.outflows[0]?.amount.asset).toBe("lamports");
      expect(intent.outflows[0]?.amount.amount).toBe("1000");
      expect(intent.outflows[0]?.to).toBe(DEST);
    }
  });

  it("Token + Token-2022 transferChecked → full in the table, partial without", () => {
    const tokenIx = getTransferCheckedInstruction({
      source: SRC_TOKEN as never,
      mint: MINT,
      destination: DST_TOKEN,
      authority: feePayerSigner,
      amount: 50n,
      decimals: 6,
    });
    const t22Ix = getTransferCheckedInstruction2022({
      source: SRC_TOKEN as never,
      mint: MINT,
      destination: DST_TOKEN,
      authority: feePayerSigner,
      amount: 50n,
      decimals: 6,
    });
    for (const ix of [tokenIx, t22Ix]) {
      const intent = decodeSolana(req(compile([ix])) as never, FEE_PAYER, table);
      expect(intent.verifiability).toBe("full");
      expect(intent.outflows[0]?.amount.asset).toBe(MINT);
      expect(intent.outflows[0]?.amount.amount).toBe("50");
      expect(intent.outflows[0]?.to).toBe(DST_TOKEN);
      expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER, {})).toBe("partial");
    }
  });

  it("Token approve → partial with the delegate as spender", () => {
    const ix = getApproveInstruction({
      source: SRC_TOKEN as never,
      delegate: DELEGATE,
      owner: feePayerSigner,
      amount: 5n,
    });
    const intent = decodeSolana(req(compile([ix])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("partial");
    expect(intent.approvals[0]?.spender).toBe(DELEGATE);
    expect(intent.approvals[0]?.amount).toBe("5");
  });

  it("ATA create and createIdempotent → full", () => {
    const createIx = getCreateAssociatedTokenInstruction({
      payer: feePayerSigner,
      ata: ATA,
      owner: DEST,
      mint: MINT,
    });
    const idempotentIx = getCreateAssociatedTokenIdempotentInstruction({
      payer: feePayerSigner,
      ata: ATA,
      owner: DEST,
      mint: MINT,
    });
    expect(verifiabilitySolana(req(compile([createIx])) as never, FEE_PAYER)).toBe("full");
    expect(verifiabilitySolana(req(compile([idempotentIx])) as never, FEE_PAYER)).toBe("full");
  });

  it("Compute Budget pair → full and sets the fee ceiling", () => {
    const limitIx = getSetComputeUnitLimitInstruction({ units: 200000 });
    const priceIx = getSetComputeUnitPriceInstruction({ microLamports: 1000n });
    const intent = decodeSolana(req(compile([limitIx, priceIx, transferIx()])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("full");
    expect(intent.fee?.max.amount).toBe("5200");
  });

  it("Stake instruction → partial", () => {
    const ix = getDelegateStakeInstruction({
      stake: STAKE_ACCT as never,
      vote: VOTE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("partial");
  });

  it("lookup tables present → partial", () => {
    const message = compile([transferIx()], 0, { [LOOKUP_TABLE]: [DEST] });
    const n = normalizeSolana(
      {
        ...req(message),
        lookupTables: [{ address: LOOKUP_TABLE, addresses: [DEST] }],
      },
      FEE_PAYER,
    );
    expect(verifiabilitySolana(n as never, FEE_PAYER)).toBe("partial");
  });

  it("unknown program → opaque", () => {
    const ix = {
      programAddress: address("Vote111111111111111111111111111111111111111"),
      accounts: [],
      data: new Uint8Array([1]),
    };
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("opaque");
  });

  it("System createAccount (non-transfer) → opaque", () => {
    const ix = getCreateAccountInstruction({
      payer: feePayerSigner,
      newAccount: createNoopSigner(DEST),
      lamports: 1000n,
      space: 100n,
      programAddress: address("11111111111111111111111111111111"),
    });
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("opaque");
  });
});
