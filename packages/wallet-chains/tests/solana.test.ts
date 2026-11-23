import { isUtf8 } from "node:buffer";
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  StakeAuthorize,
  getAuthorizeCheckedInstruction,
  getAuthorizeInstruction,
  getDeactivateInstruction,
  getDelegateStakeInstruction,
  getInitializeCheckedInstruction,
  getInitializeInstruction,
  getMergeInstruction,
  getWithdrawInstruction,
} from "@solana-program/stake";
import {
  getCreateAccountInstruction,
  getCreateAccountWithSeedInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import {
  getApproveInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getCreateAssociatedTokenInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  getRevokeInstruction as getRevokeInstruction2022,
  getTransferCheckedInstruction as getTransferCheckedInstruction2022,
} from "@solana-program/token-2022";
import { address, getAddressDecoder, getAddressEncoder } from "@solana/addresses";
import {
  AccountRole,
  assertIsSignatureBytes,
  createNoopSigner,
  verifySignature,
} from "@solana/kit";
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

import { createMessage } from "@qntx/siwx";
import { siws } from "@qntx/siwx/svm";

import { RECOGNISED_FAMILIES } from "../src/families.ts";
import { ChainError, messageBlindReason, messageContent } from "../src/index.ts";
import { solanaAddressFromPublicKey } from "../src/solana/ids.ts";
import {
  PROGRAM_IDS,
  SOLANA_NATIVE_ASSET,
  associatedTokenAddress,
  decodeSolana,
  mayBeTransactionMessage,
  parseCompiledMessage,
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
  version: "legacy" | 0 | 1 = "legacy",
  lookupAddresses?: Record<string, ReadonlyArray<string>>,
  payer: string = FEE_PAYER,
): Uint8Array => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(address(payer), createTransactionMessage({ version })),
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

/** A code point whose UTF-8 encoding starts with `lead` (0xc2–0xf4) — the tests' UTF-8 oracle. */
const utf8LeadChar = (lead: number): string =>
  String.fromCodePoint(
    lead <= 0xdf
      ? (lead - 0xc0) * 0x40 + 0x20
      : lead <= 0xef
        ? // The 0xed range holds the surrogates — take a code point below them.
          (lead - 0xe0) * 0x1000 + (lead === 0xed ? 0 : 0x800)
        : lead === 0xf4
          ? 0x10ffff
          : (lead - 0xf0) * 0x40000 + 0x10000,
  );

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

  it("accepts the wallet as a required signer that is not the fee payer", () => {
    // DEST sponsors the fee; the transfer source keeps FEE_PAYER a required signer.
    const sponsored = compile([transferIx()], "legacy", undefined, DEST);
    expect(normalizeSolana(req(sponsored), FEE_PAYER).kind).toBe("solana.transaction");
  });

  it("rejects a signer that is not among the required signers", () => {
    expect(() => normalizeSolana(req(compile([transferIx()])), DEST)).toThrow(
      /not a required signer/,
    );
  });

  it("rejects >1232-byte and non-message payloads", () => {
    expect(() => normalizeSolana(req(new Uint8Array(1233)), FEE_PAYER)).toThrow(ChainError);
    expect(() => normalizeSolana(req(new Uint8Array(3)), FEE_PAYER)).toThrow(ChainError);
  });

  it("rejects unknown networks", () => {
    const bad = { ...req(compile([transferIx()])), network: "solana:unknown" };
    expect(() => normalizeSolana(bad, FEE_PAYER)).toThrow(ChainError);
  });

  it("rejects lookup tables on a v1 transaction — v1 has no address lookup tables", () => {
    const withTables = {
      ...req(compile([transferIx()], 1)),
      lookupTables: [{ address: LOOKUP_TABLE, addresses: [DEST] }],
    };
    expect(() => normalizeSolana(withTables, FEE_PAYER)).toThrow(/no address lookup tables/);
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

describe("raw solana.message blindness", () => {
  /** The message bytes the kernel signs, after `normalizeSolana`'s checks. */
  const messageBytes = (bytes: Uint8Array): Uint8Array => {
    const normalized = normalizeSolana(
      { ...req(bytes), kind: "solana.message", format: "raw" },
      FEE_PAYER,
    );
    if (normalized.kind !== "solana.message") {
      throw new Error("unreachable: normalization changed the kind");
    }
    return normalized.message;
  };

  it("a digest or its hex rendering is blind; ordinary text is not", () => {
    // The ground digest: a keccak output that happens to be valid UTF-8.
    const digest = hexToBytes("5718efa1a01c4e34c7b5481f5450604d1274491d0f310532dcbd7461c9ae3b79");
    for (const bytes of [
      digest,
      new TextEncoder().encode(`0x${Buffer.from(digest).toString("hex")}`),
    ]) {
      expect(messageBlindReason(messageContent(messageBytes(bytes), "solana"))).toBe(
        "message-bytes",
      );
    }
    const text = messageBytes(new TextEncoder().encode("hello world"));
    expect(messageBlindReason(messageContent(text, "solana"))).toBeUndefined();
  });
});

describe("transaction-message refusal of raw solana.message", () => {
  const asRaw = (message: Uint8Array) => ({
    ...req(message),
    kind: "solana.message",
    format: "raw",
  });
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return error instanceof ChainError ? error.code : "other";
    }
    return undefined;
  };

  it("refuses a kit-compiled v1 message passed as a raw message", () => {
    expect(() => normalizeSolana(asRaw(compile([transferIx()], 1)), FEE_PAYER)).toThrow(ChainError);
  });

  it("accepts a v1 transaction and refuses only the higher versioned prefixes", () => {
    expect(normalizeSolana(req(compile([transferIx()], 1)), FEE_PAYER).kind).toBe(
      "solana.transaction",
    );
    expect(codeOf(() => parseCompiledMessage(new Uint8Array([0x81, 0])))).toBe("invalid-request");
    for (const first of [0x82, 0xfe]) {
      expect(codeOf(() => parseCompiledMessage(new Uint8Array([first, 0])))).toBe("unsupported");
    }
  });

  const byteRange = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  const hexByte = (b: number): [string, number] => [b.toString(16).padStart(2, "0"), b];

  it.each(byteRange(0x00, 0x7f).map(hexByte))(
    "a short payload starting 0x%s is raw-signable",
    (_label, b) => {
      expect(mayBeTransactionMessage(new Uint8Array([b]))).toBe(false);
      expect(mayBeTransactionMessage(new Uint8Array([b, 0xff]))).toBe(false);
    },
  );

  it("refuses a complete legacy message but not one with a trailing byte", () => {
    const legacy = compile([transferIx()]);
    expect(mayBeTransactionMessage(legacy)).toBe(true);
    expect(mayBeTransactionMessage(new Uint8Array([...legacy, 0]))).toBe(false);
    expect(mayBeTransactionMessage(new Uint8Array(0))).toBe(false);
  });

  it.each([...byteRange(0x80, 0xc1), ...byteRange(0xf5, 0xfe)].map(hexByte))(
    "a versioned prefix 0x%s is refused with any suffix",
    (_label, b) => {
      expect(mayBeTransactionMessage(new Uint8Array([b, ...Buffer.from("tail", "utf8")]))).toBe(
        true,
      );
      expect(mayBeTransactionMessage(new Uint8Array([b, 0x01, 0x02]))).toBe(true);
    },
  );

  it.each(byteRange(0xc2, 0xf4).map(hexByte))(
    "a lead byte 0x%s passes only as well-formed UTF-8",
    (_label, b) => {
      expect(mayBeTransactionMessage(new Uint8Array([b, 0x00]))).toBe(true);
      expect(mayBeTransactionMessage(new Uint8Array([b, 0xff]))).toBe(true);
      const text = Buffer.from(`${utf8LeadChar(b)} sign in`, "utf8");
      expect(text[0]).toBe(b);
      expect(isUtf8(text)).toBe(true);
      expect(mayBeTransactionMessage(new Uint8Array(text))).toBe(false);
    },
  );

  it("0xff is always raw-signable, including the off-chain envelope", () => {
    expect(mayBeTransactionMessage(new Uint8Array([0xff]))).toBe(false);
    const envelope = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from("solana offchain"),
      Buffer.alloc(16),
    ]);
    expect(mayBeTransactionMessage(new Uint8Array(envelope))).toBe(false);
  });

  it("keeps real-world texts signable and refuses transaction-shaped bytes", () => {
    const siwsText = siws.format(
      createMessage({
        domain: "example.com",
        address: FEE_PAYER,
        uri: "https://example.com/login",
        version: "1",
        chainId: "mainnet",
        nonce: "12341234",
        issuedAt: "2022-03-17T12:45:13.610Z",
      }),
    );
    for (const text of [siwsText, "你好，签名", "🔐 Sign in to example.com", "plain ascii"]) {
      const bytes = new TextEncoder().encode(text);
      expect(mayBeTransactionMessage(bytes)).toBe(false);
      expect(normalizeSolana(asRaw(bytes), FEE_PAYER).kind).toBe("solana.message");
    }
    const v0 = compile([transferIx()], 0);
    const v1 = compile([transferIx()], 1);
    expect(mayBeTransactionMessage(v0)).toBe(true);
    expect(mayBeTransactionMessage(new Uint8Array([...v0, 0]))).toBe(true);
    expect(mayBeTransactionMessage(new Uint8Array([...v1, 0]))).toBe(true);
    for (let b = 0x82; b <= 0xfe; b += 1) {
      expect(mayBeTransactionMessage(new Uint8Array([b, ...v1.slice(1)]))).toBe(true);
    }
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
    expect(intent.approvals[0]).toMatchObject({
      kind: "allowance",
      spender: DELEGATE,
      amount: { amount: "5" },
      change: "set",
      unlimited: false,
    });
  });

  it.each([
    ["Token", getRevokeInstruction({ source: SRC_TOKEN, owner: feePayerSigner })],
    ["Token-2022", getRevokeInstruction2022({ source: SRC_TOKEN, owner: feePayerSigner })],
  ])("%s Revoke → full, a delegate-revoked naming the token account", (_name, revoke) => {
    const intent = decodeSolana(req(compile([revoke])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("full");
    expect(intent.outflows).toStrictEqual([]);
    expect(intent.approvals).toStrictEqual([
      { kind: "delegate-revoked", account: SRC_TOKEN, verified: false },
    ]);
  });

  it("a Revoke's token account resolves through a lookup table", () => {
    const revoke = getRevokeInstruction({ source: SRC_TOKEN, owner: feePayerSigner });
    const message = compile([revoke], 0, { [LOOKUP_TABLE]: [SRC_TOKEN] });
    const intent = decodeSolana(
      {
        ...req(message),
        lookupTables: [{ address: LOOKUP_TABLE, addresses: [SRC_TOKEN] }],
      } as never,
      FEE_PAYER,
    );
    expect(intent.verifiability).toBe("partial");
    expect(intent.approvals).toStrictEqual([
      { kind: "delegate-revoked", account: SRC_TOKEN, verified: false },
    ]);
  });

  it("two Revokes in one transaction each name their token account", () => {
    const revokes = [
      getRevokeInstruction({ source: SRC_TOKEN, owner: feePayerSigner }),
      getRevokeInstruction2022({ source: DST_TOKEN, owner: feePayerSigner }),
    ];
    const intent = decodeSolana(req(compile(revokes)) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("full");
    expect(intent.approvals).toStrictEqual([
      { kind: "delegate-revoked", account: SRC_TOKEN, verified: false },
      { kind: "delegate-revoked", account: DST_TOKEN, verified: false },
    ]);
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

  it("shows a zero max fee when the wallet is not the fee payer", () => {
    const sponsored = compile([transferIx()], "legacy", undefined, DEST);
    expect(decodeSolana(req(sponsored) as never, FEE_PAYER).fee?.max.amount).toBe("0");
  });

  const tokenIxForFee = () =>
    getTransferCheckedInstruction({
      source: SRC_TOKEN as never,
      mint: MINT,
      destination: DST_TOKEN,
      authority: feePayerSigner,
      amount: 50n,
      decimals: 6,
    });
  const feeOf = (ixs: Parameters<typeof compile>[0]) =>
    decodeSolana(req(compile(ixs)) as never, FEE_PAYER).fee?.max.amount;

  it("no SetComputeUnitLimit: builtins count 3,000 CU toward the default limit", () => {
    const micro = 5_000_000_000_000n;
    const limit = 2n * 3000n;
    expect(feeOf([getSetComputeUnitPriceInstruction({ microLamports: micro }), transferIx()])).toBe(
      String(5000n + (micro * limit + 999_999n) / 1_000_000n),
    );
  });

  it("a non-builtin instruction costs its 200,000 CU default", () => {
    const micro = 1000n;
    const limit = 3000n + 200_000n;
    expect(
      feeOf([getSetComputeUnitPriceInstruction({ microLamports: micro }), tokenIxForFee()]),
    ).toBe(String(5000n + (micro * limit + 999_999n) / 1_000_000n));
  });

  it("a requested limit above 1,400,000 is capped", () => {
    const micro = 1000n;
    expect(
      feeOf([
        getSetComputeUnitLimitInstruction({ units: 2_000_000 }),
        getSetComputeUnitPriceInstruction({ microLamports: micro }),
        transferIx(),
      ]),
    ).toBe(String(5000n + (micro * 1_400_000n + 999_999n) / 1_000_000n));
  });

  it("no SetComputeUnitPrice: the fee is the signature cost only", () => {
    expect(feeOf([transferIx()])).toBe("5000");
  });

  it("duplicate compute-budget instructions are rejected", () => {
    expect(() =>
      feeOf([
        getSetComputeUnitPriceInstruction({ microLamports: 1000n }),
        getSetComputeUnitPriceInstruction({ microLamports: 2000n }),
        transferIx(),
      ]),
    ).toThrow("duplicate compute-budget instruction");
    expect(() =>
      feeOf([
        getSetComputeUnitLimitInstruction({ units: 200_000 }),
        getSetComputeUnitLimitInstruction({ units: 300_000 }),
        transferIx(),
      ]),
    ).toThrow("duplicate compute-budget instruction");
  });

  it("the instruction-count default limit is capped at 1,400,000", () => {
    const micro = 1000n;
    const ixs = [
      getSetComputeUnitPriceInstruction({ microLamports: micro }),
      ...Array.from({ length: 8 }, tokenIxForFee),
    ];
    expect(feeOf(ixs)).toBe(String(5000n + (micro * 1_400_000n + 999_999n) / 1_000_000n));
  });

  it("a recognized stake instruction is full; an unrecognized one is opaque", () => {
    const ix = getDelegateStakeInstruction({
      stake: STAKE_ACCT as never,
      vote: VOTE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("full");
    const unknown = stakeIx(
      [{ address: STAKE_ACCT, role: AccountRole.WRITABLE }],
      cat(u32le(7), u64le(0n)),
    );
    expect(verifiabilitySolana(req(compile([unknown])) as never, FEE_PAYER)).toBe("opaque");
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

  it("parseCompiledMessage returns each lookup's writable and readonly indexes", () => {
    const message = compile([transferIx()], 0, { [LOOKUP_TABLE]: [DEST] });
    const parsed = parseCompiledMessage(message);
    expect(parsed.lookups).toStrictEqual([
      { address: LOOKUP_TABLE, writableIndexes: [0], readonlyIndexes: [] },
    ]);
    expect(parseCompiledMessage(compile([transferIx()])).lookups).toStrictEqual([]);
  });

  it("exports the native asset ids the decode uses", () => {
    expect(SOLANA_NATIVE_ASSET).toBe("lamports");
    const intent = decodeSolana(req(compile([transferIx()])) as never, FEE_PAYER);
    expect(intent.outflows[0]?.amount.asset).toBe(SOLANA_NATIVE_ASSET);
  });

  it("unknown program → opaque", () => {
    const ix = {
      programAddress: address("Vote111111111111111111111111111111111111111"),
      accounts: [],
      data: new Uint8Array([1]),
    };
    expect(verifiabilitySolana(req(compile([ix])) as never, FEE_PAYER)).toBe("opaque");
  });

  it("System createAccount for a non-stake owner → full with a lamports outflow", () => {
    const ix = getCreateAccountInstruction({
      payer: feePayerSigner,
      newAccount: createNoopSigner(DEST),
      lamports: 1000n,
      space: 100n,
      programAddress: address("11111111111111111111111111111111"),
    });
    const intent = decodeSolana(req(compile([ix])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("full");
    expect(intent.outflows[0]?.to).toBe(DEST);
    expect(intent.outflows[0]?.amount).toStrictEqual({
      asset: SOLANA_NATIVE_ASSET,
      amount: "1000",
      decimals: 9,
      symbol: "SOL",
    });
  });

  it("System createAccount funded by a second signer is not an outflow of ours", () => {
    const ix = getCreateAccountInstruction({
      payer: createNoopSigner(OTHER_KEY),
      newAccount: createNoopSigner(DEST),
      lamports: 1000n,
      space: 100n,
      programAddress: address("11111111111111111111111111111111"),
    });
    const intent = decodeSolana(req(compile([ix])) as never, FEE_PAYER);
    expect(intent.outflows).toStrictEqual([]);
  });
});

describe("precompile instruction signatures count toward the fee", () => {
  /* Agave signature_details.rs: an instruction to a signature-verification precompile adds
     data[0] (0 for empty data) to the signatures the transaction fee pays for. */
  const PRECOMPILES = [
    ["ed25519", PROGRAM_IDS.ed25519],
    ["secp256k1", PROGRAM_IDS.secp256k1],
    ["secp256r1", PROGRAM_IDS.secp256r1],
  ] as const;

  const ix = (program: string, data: ReadonlyArray<number>) => ({
    programAddress: address(program),
    accounts: [],
    data: new Uint8Array(data),
  });

  const feeOf = (
    ixs: ReadonlyArray<unknown>,
    version: "legacy" | 0 | 1 = "legacy",
    payer: string = FEE_PAYER,
  ) =>
    decodeSolana(req(compile(ixs, version, undefined, payer)) as never, FEE_PAYER).fee?.max.amount;

  it.each(PRECOMPILES)("a %s instruction with empty data adds nothing", (_name, program) => {
    for (const version of ["legacy", 0, 1] as const) {
      expect(feeOf([ix(program, [])], version)).toBe("5000");
    }
  });

  it.each(PRECOMPILES)("a %s instruction with data[0]=0 adds nothing", (_name, program) => {
    for (const version of ["legacy", 0, 1] as const) {
      expect(feeOf([ix(program, [0])], version)).toBe("5000");
    }
  });

  it.each(PRECOMPILES)("a %s instruction with data[0]=2 adds two", (_name, program) => {
    for (const version of ["legacy", 0, 1] as const) {
      expect(feeOf([ix(program, [2])], version)).toBe("15000");
    }
  });

  it.each(PRECOMPILES)("two %s instructions sum their counts", (_name, program) => {
    for (const version of ["legacy", 0, 1] as const) {
      expect(feeOf([ix(program, [2]), ix(program, [1])], version)).toBe("20000");
    }
  });

  it("a sponsored signer pays nothing even with precompile signatures", () => {
    expect(feeOf([ix(PROGRAM_IDS.ed25519, [2]), transferIx()], "legacy", DEST)).toBe("0");
  });
});

const STAKE_PROG = "Stake11111111111111111111111111111111111111";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";
const STAKE_HIST = "SysvarStakeHistory1111111111111111111111111";
const STAKE_CONF = "StakeConfig11111111111111111111111111111111";
const OTHER_KEY = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const stakeSigner = createNoopSigner(STAKE_ACCT);

const ro = (addr: string) => ({ address: address(addr), role: AccountRole.READONLY });
const w0 = (addr: string) => ({ address: address(addr), role: AccountRole.WRITABLE });
const sgn = (addr: string) => ({
  address: address(addr),
  role: AccountRole.READONLY_SIGNER,
  signer: createNoopSigner(address(addr)),
});

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64le = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const cat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => [...p]));

const stakeIx = (accounts: ReadonlyArray<object>, data: Uint8Array) => ({
  programAddress: address(STAKE_PROG),
  accounts,
  data,
});

describe("stake decode", () => {
  it("create + initialize + delegate (new forms) → stake/full, three actions, one outflow", () => {
    const cuLimit = getSetComputeUnitLimitInstruction({ units: 200000 });
    const cuPrice = getSetComputeUnitPriceInstruction({ microLamports: 1n });
    const create = getCreateAccountInstruction({
      payer: feePayerSigner,
      newAccount: stakeSigner,
      lamports: 2_000_000_000n,
      space: 200n,
      programAddress: address(STAKE_PROG),
    });
    const init = getInitializeInstruction({
      stake: STAKE_ACCT,
      arg0: { staker: FEE_PAYER, withdrawer: FEE_PAYER },
      arg1: {
        custodian: address("11111111111111111111111111111111"),
        epoch: 0n,
        unixTimestamp: 0n,
      },
    });
    const delegate = getDelegateStakeInstruction({
      stake: STAKE_ACCT,
      vote: VOTE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    const intent = decodeSolana(
      req(compile([cuLimit, cuPrice, create, init, delegate])) as never,
      FEE_PAYER,
    );
    expect(intent.summary).toBe("stake");
    expect(intent.verifiability).toBe("full");
    expect(intent.staking).toStrictEqual([
      { kind: "create", account: STAKE_ACCT, lamports: "2000000000" },
      { kind: "delegate", account: STAKE_ACCT, validator: VOTE_ACCT },
    ]);
    expect(intent.outflows).toStrictEqual([
      {
        to: STAKE_ACCT,
        amount: { asset: SOLANA_NATIVE_ASSET, amount: "2000000000", decimals: 9, symbol: "SOL" },
        verified: true,
      },
    ]);
    expect(intent.approvals).toStrictEqual([]);
  });

  it("legacy account lists decode the same as the new forms", () => {
    const init = getInitializeInstruction({
      stake: STAKE_ACCT,
      arg0: { staker: FEE_PAYER, withdrawer: FEE_PAYER },
      arg1: {
        custodian: address("11111111111111111111111111111111"),
        epoch: 0n,
        unixTimestamp: 0n,
      },
    });
    const legacyInit = stakeIx(
      [{ address: STAKE_ACCT, role: AccountRole.WRITABLE }, ro(RENT)],
      Uint8Array.from(init.data),
    );
    const delegate = getDelegateStakeInstruction({
      stake: STAKE_ACCT,
      vote: VOTE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    const legacyDelegate = stakeIx(
      [
        { address: STAKE_ACCT, role: AccountRole.WRITABLE },
        ro(VOTE_ACCT),
        ro(CLOCK),
        ro(STAKE_HIST),
        ro(STAKE_CONF),
        sgn(FEE_PAYER),
      ],
      Uint8Array.from(delegate.data),
    );
    const intent = decodeSolana(req(compile([legacyInit, legacyDelegate])) as never, FEE_PAYER);
    expect(intent.summary).toBe("stake");
    expect(intent.staking).toStrictEqual([
      { kind: "delegate", account: STAKE_ACCT, validator: VOTE_ACCT },
    ]);
  });

  it("deactivate → stake action, no outflow", () => {
    const deact = getDeactivateInstruction({
      stake: STAKE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    const intent = decodeSolana(req(compile([deact])) as never, FEE_PAYER);
    expect(intent.summary).toBe("stake");
    expect(intent.staking).toStrictEqual([{ kind: "deactivate", account: STAKE_ACCT }]);
    expect(intent.outflows).toStrictEqual([]);
  });

  it("withdraw to the signer has no outflow; to another address it does", () => {
    const self = getWithdrawInstruction({
      stake: STAKE_ACCT,
      recipient: FEE_PAYER,
      withdrawAuthority: feePayerSigner,
      args: 500_000_000n,
    });
    const selfIntent = decodeSolana(req(compile([self])) as never, FEE_PAYER);
    expect(selfIntent.staking).toStrictEqual([
      { kind: "withdraw", account: STAKE_ACCT, to: FEE_PAYER, lamports: "500000000" },
    ]);
    expect(selfIntent.outflows).toStrictEqual([]);
    const other = getWithdrawInstruction({
      stake: STAKE_ACCT,
      recipient: OTHER_KEY,
      withdrawAuthority: feePayerSigner,
      args: 500_000_000n,
    });
    const otherIntent = decodeSolana(req(compile([other])) as never, FEE_PAYER);
    expect(otherIntent.outflows).toStrictEqual([
      {
        to: OTHER_KEY,
        amount: { asset: SOLANA_NATIVE_ASSET, amount: "500000000", decimals: 9, symbol: "SOL" },
        verified: true,
      },
    ]);
  });

  it("Authorize/AuthorizeChecked to another key → stake-authority approval", () => {
    const auth = getAuthorizeInstruction({
      stake: STAKE_ACCT,
      authority: feePayerSigner,
      arg0: OTHER_KEY,
      arg1: StakeAuthorize.Staker,
    });
    const authChecked = getAuthorizeCheckedInstruction({
      stake: STAKE_ACCT,
      authority: feePayerSigner,
      newAuthority: createNoopSigner(OTHER_KEY),
      stakeAuthorize: StakeAuthorize.Withdrawer,
    });
    const intent = decodeSolana(req(compile([auth, authChecked])) as never, FEE_PAYER);
    expect(intent.approvals).toStrictEqual([
      {
        kind: "stake-authority",
        account: STAKE_ACCT,
        role: "staker",
        authority: OTHER_KEY,
        verified: false,
      },
      {
        kind: "stake-authority",
        account: STAKE_ACCT,
        role: "withdrawer",
        authority: OTHER_KEY,
        verified: false,
      },
    ]);
  });

  it("Initialize with a foreign withdrawer → approval; non-zero lockup → warning", () => {
    const init = getInitializeInstruction({
      stake: STAKE_ACCT,
      arg0: { staker: FEE_PAYER, withdrawer: OTHER_KEY },
      arg1: { custodian: OTHER_KEY, epoch: 0n, unixTimestamp: 1_900_000_000n },
    });
    const intent = decodeSolana(req(compile([init])) as never, FEE_PAYER);
    expect(intent.approvals).toStrictEqual([
      {
        kind: "stake-authority",
        account: STAKE_ACCT,
        role: "withdrawer",
        authority: OTHER_KEY,
        verified: false,
      },
    ]);
    expect(intent.warnings.some((w) => w.kind === "stake-lockup")).toBe(true);
  });

  it("CreateAccountWithSeed whose address does not match the derivation → opaque", () => {
    /* The new account must be sha256(base ‖ seed ‖ owner) — the program enforces it on-chain. */
    const seedBytes = new TextEncoder().encode("stake:0");
    const derived = solanaAddressFromPublicKey(
      sha256(
        Uint8Array.from([
          ...getAddressEncoder().encode(FEE_PAYER),
          ...seedBytes,
          ...getAddressEncoder().encode(address(STAKE_PROG)),
        ]),
      ),
    );
    const ix = getCreateAccountWithSeedInstruction({
      payer: feePayerSigner,
      newAccount: address(derived),
      base: FEE_PAYER,
      seed: "stake:0",
      amount: 1_000_000_000n,
      space: 200n,
      programAddress: address(STAKE_PROG),
    });
    const good = decodeSolana(req(compile([ix])) as never, FEE_PAYER);
    expect(good.staking?.[0]?.kind).toBe("create");
    const badIx = getCreateAccountWithSeedInstruction({
      payer: feePayerSigner,
      newAccount: OTHER_KEY,
      base: FEE_PAYER,
      seed: "stake:0",
      amount: 1_000_000_000n,
      space: 200n,
      programAddress: address(STAKE_PROG),
    });
    const bad = decodeSolana(req(compile([badIx])) as never, FEE_PAYER);
    expect(bad.verifiability).toBe("opaque");
    expect(bad.blind).toBe("core-instruction");
  });

  it("Split/Merge and truncated data → opaque; the signer-signed ones are blind", () => {
    const merge = getMergeInstruction({
      destinationStake: STAKE_ACCT,
      sourceStake: OTHER_KEY,
      stakeAuthority: feePayerSigner,
    });
    const merged = decodeSolana(req(compile([merge])) as never, FEE_PAYER);
    expect(merged.verifiability).toBe("opaque");
    expect(merged.blind).toBe("core-instruction");
    const truncated = stakeIx(
      [{ address: STAKE_ACCT, role: AccountRole.WRITABLE }],
      u32le(0).subarray(0, 3),
    );
    const short = decodeSolana(req(compile([truncated])) as never, FEE_PAYER);
    expect(short.verifiability).toBe("opaque");
    expect(short.blind).toBeUndefined();
    const extended = stakeIx(
      [{ address: STAKE_ACCT, role: AccountRole.WRITABLE }, ro(FEE_PAYER), sgn(FEE_PAYER)],
      cat(u32le(5), u64le(0n)),
    );
    const long = decodeSolana(req(compile([extended])) as never, FEE_PAYER);
    expect(long.verifiability).toBe("opaque");
    expect(long.blind).toBe("core-instruction");
  });

  it("a second signer's transfer is not attributed to the fee payer", () => {
    const second = createNoopSigner(OTHER_KEY);
    const ix = getTransferSolInstruction({ source: second, destination: DEST, amount: 7n });
    const intent = decodeSolana(req(compile([ix])) as never, FEE_PAYER);
    expect(intent.outflows).toStrictEqual([]);
  });

  it("the fixed vectors decode to their recorded intents", () => {
    const vectors = (
      JSON.parse(
        readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
      ) as {
        stake: ReadonlyArray<{
          name: string;
          message: string;
          expected: {
            summary: string;
            verifiability: string;
            staking: ReadonlyArray<unknown>;
            outflows: ReadonlyArray<unknown>;
            approvals: ReadonlyArray<unknown>;
          };
        }>;
      }
    ).stake;
    for (const v of vectors) {
      const intent = decodeSolana(
        req(Uint8Array.from(Buffer.from(v.message, "hex"))) as never,
        FEE_PAYER,
      );
      expect({
        summary: intent.summary,
        verifiability: intent.verifiability,
        staking: intent.staking,
        outflows: intent.outflows,
        approvals: intent.approvals,
      }).toStrictEqual(v.expected);
    }
  });
});

describe("stake decode coverage", () => {
  it("legacy Authorize/AuthorizeChecked/Withdraw/Deactivate/InitializeChecked decode", () => {
    const auth = getAuthorizeInstruction({
      stake: STAKE_ACCT,
      authority: feePayerSigner,
      arg0: OTHER_KEY,
      arg1: StakeAuthorize.Withdrawer,
    });
    const legacyAuth = stakeIx(
      [w0(STAKE_ACCT), ro(CLOCK), sgn(FEE_PAYER), sgn(OTHER_KEY)],
      Uint8Array.from(auth.data),
    );
    const authChecked = getAuthorizeCheckedInstruction({
      stake: STAKE_ACCT,
      authority: feePayerSigner,
      newAuthority: createNoopSigner(OTHER_KEY),
      stakeAuthorize: StakeAuthorize.Staker,
    });
    const legacyAuthChecked = stakeIx(
      [w0(STAKE_ACCT), ro(CLOCK), sgn(FEE_PAYER), sgn(OTHER_KEY), sgn(OTHER_KEY)],
      Uint8Array.from(authChecked.data),
    );
    const withdraw = getWithdrawInstruction({
      stake: STAKE_ACCT,
      recipient: OTHER_KEY,
      withdrawAuthority: feePayerSigner,
      args: 1_000_000n,
    });
    const legacyWithdraw = stakeIx(
      [w0(STAKE_ACCT), w0(OTHER_KEY), ro(CLOCK), ro(STAKE_HIST), sgn(FEE_PAYER), sgn(OTHER_KEY)],
      Uint8Array.from(withdraw.data),
    );
    const deact = getDeactivateInstruction({
      stake: STAKE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    const legacyDeact = stakeIx(
      [w0(STAKE_ACCT), ro(CLOCK), sgn(FEE_PAYER)],
      Uint8Array.from(deact.data),
    );
    const initChecked = getInitializeCheckedInstruction({
      stake: STAKE_ACCT,
      stakeAuthority: FEE_PAYER,
      withdrawAuthority: createNoopSigner(OTHER_KEY),
    });
    const legacyInitChecked = stakeIx(
      [w0(STAKE_ACCT), ro(RENT), ro(FEE_PAYER), sgn(OTHER_KEY)],
      Uint8Array.from(initChecked.data),
    );
    const intent = decodeSolana(
      req(
        compile([legacyAuth, legacyAuthChecked, legacyWithdraw, legacyDeact, legacyInitChecked]),
      ) as never,
      FEE_PAYER,
    );
    expect(intent.summary).toBe("stake");
    const toSigner = getAuthorizeInstruction({
      stake: STAKE_ACCT,
      authority: feePayerSigner,
      arg0: FEE_PAYER,
      arg1: StakeAuthorize.Staker,
    });
    expect(decodeSolana(req(compile([toSigner])) as never, FEE_PAYER).approvals).toStrictEqual([]);
    expect(intent.staking).toStrictEqual([
      { kind: "withdraw", account: STAKE_ACCT, to: OTHER_KEY, lamports: "1000000" },
      { kind: "deactivate", account: STAKE_ACCT },
    ]);
    expect(intent.approvals).toStrictEqual([
      {
        kind: "stake-authority",
        account: STAKE_ACCT,
        role: "withdrawer",
        authority: OTHER_KEY,
        verified: false,
      },
      {
        kind: "stake-authority",
        account: STAKE_ACCT,
        role: "staker",
        authority: OTHER_KEY,
        verified: false,
      },
      {
        kind: "stake-authority",
        account: STAKE_ACCT,
        role: "withdrawer",
        authority: OTHER_KEY,
        verified: false,
      },
    ]);
  });

  it("rejects wrong account counts, roles, owners and shapes", () => {
    const opaque = (ixs: ReadonlyArray<unknown>) =>
      decodeSolana(req(compile(ixs)) as never, FEE_PAYER).verifiability;
    /* Authorize with a role outside staker/withdrawer. */
    expect(
      opaque([
        stakeIx(
          [w0(STAKE_ACCT), sgn(FEE_PAYER)],
          cat(u32le(1), Uint8Array.from(getAddressEncoder().encode(OTHER_KEY)), u32le(5)),
        ),
      ]),
    ).toBe("opaque");
    /* Authorize with too few accounts. */
    expect(
      opaque([
        stakeIx(
          [w0(STAKE_ACCT)],
          cat(u32le(1), Uint8Array.from(getAddressEncoder().encode(OTHER_KEY)), u32le(0)),
        ),
      ]),
    ).toBe("opaque");
    /* DelegateStake with the Clock sysvar missing from the legacy position. */
    expect(
      opaque([stakeIx([w0(STAKE_ACCT), ro(VOTE_ACCT), sgn(FEE_PAYER), ro(CLOCK)], u32le(2))]),
    ).toBe("opaque");
    /* Truncated create-account data. */
    expect(
      opaque([
        {
          programAddress: address("11111111111111111111111111111111"),
          accounts: [sgn(FEE_PAYER), sgn(STAKE_ACCT)],
          data: u32le(0),
        },
      ]),
    ).toBe("opaque");
    /* With-seed whose base account doesn't match the data's base. */
    expect(
      opaque([
        {
          programAddress: address("11111111111111111111111111111111"),
          accounts: [sgn(FEE_PAYER), w0(STAKE_ACCT), sgn(OTHER_KEY)],
          data: cat(
            u32le(3),
            Uint8Array.from(getAddressEncoder().encode(FEE_PAYER)),
            u64le(4n),
            new TextEncoder().encode("seed"),
            u64le(1n),
            u64le(200n),
            Uint8Array.from(getAddressEncoder().encode(address(STAKE_PROG))),
          ),
        },
      ]),
    ).toBe("opaque");
  });
});

describe("undecodable instructions list their program ids", () => {
  const unknownIx = (program: string) => ({
    programAddress: address(program),
    accounts: [],
    data: new Uint8Array([1]),
  });
  const VOTE = "Vote111111111111111111111111111111111111111";
  const SYSTEM = "11111111111111111111111111111111";

  it("an unknown program is opaque and named, not blind", () => {
    const intent = decodeSolana(req(compile([unknownIx(VOTE)])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.programs).toStrictEqual([VOTE]);
    expect(intent.blind).toBeUndefined();
  });

  it("an unrecognised instruction of a known program names that program", () => {
    const ix = { programAddress: address(SYSTEM), accounts: [], data: u32le(9) };
    expect(decodeSolana(req(compile([ix])) as never, FEE_PAYER).programs).toStrictEqual([SYSTEM]);
  });

  it("repeats of the same program are de-duplicated in first-appearance order", () => {
    const stake = stakeIx([w0(STAKE_ACCT)], cat(u32le(7), u64le(0n)));
    const intent = decodeSolana(
      req(compile([unknownIx(VOTE), unknownIx(VOTE), stake, unknownIx(VOTE)])) as never,
      FEE_PAYER,
    );
    expect(intent.programs).toStrictEqual([VOTE, STAKE_PROG]);
  });

  it("a fully recognised transaction carries no program list", () => {
    expect(decodeSolana(req(compile([transferIx()])) as never, FEE_PAYER).programs).toBeUndefined();
  });
});

describe("empty-data instructions decode conservatively", () => {
  /* kit's decoder omits `data` and `accountIndices` when they are empty — the wire format and
     Agave both allow empty instruction data, so the compiled-message parse accepts the absent
     field as an empty one. */
  const emptyIx = (program: string) => ({
    programAddress: address(program),
    accounts: [sgn(FEE_PAYER)],
    data: new Uint8Array(0),
  });

  it.each([
    ["system", PROGRAM_IDS.system, "legacy"],
    ["system", PROGRAM_IDS.system, 0],
    ["system", PROGRAM_IDS.system, 1],
    ["token", PROGRAM_IDS.token, "legacy"],
    ["token", PROGRAM_IDS.token, 0],
    ["token", PROGRAM_IDS.token, 1],
    ["token-2022", PROGRAM_IDS.token2022, "legacy"],
    ["token-2022", PROGRAM_IDS.token2022, 0],
    ["token-2022", PROGRAM_IDS.token2022, 1],
    ["associated token", PROGRAM_IDS.associatedToken, "legacy"],
    ["associated token", PROGRAM_IDS.associatedToken, 0],
    ["associated token", PROGRAM_IDS.associatedToken, 1],
    ["stake", PROGRAM_IDS.stake, "legacy"],
    ["stake", PROGRAM_IDS.stake, 0],
    ["stake", PROGRAM_IDS.stake, 1],
  ] as const)(
    "an empty %s instruction taking the signer is blind on %s",
    (_name, program, version) => {
      const wire = compile([emptyIx(program)], version);
      expect(parseCompiledMessage(wire).instructions[0]?.data.length).toBe(0);
      const intent = decodeSolana(req(wire) as never, FEE_PAYER);
      /* No decoder claims a data-less instruction: the near-miss of the recognised core
         programs is core-instruction — the signer-signed opaque instruction is blind. */
      expect(intent.blind).toBe("core-instruction");
      expect(intent.programs).toStrictEqual([program]);
    },
  );

  it.each([
    ["compute budget", PROGRAM_IDS.computeBudget, "legacy"],
    ["compute budget", PROGRAM_IDS.computeBudget, 1],
    ["unknown", "Vote111111111111111111111111111111111111111", "legacy"],
    ["unknown", "Vote111111111111111111111111111111111111111", 1],
  ] as const)(
    "an empty %s instruction taking the signer is opaque and named on %s",
    (_name, program, version) => {
      /* An empty instruction is no nearer a claim than any other undecoded one: an
         unrecognised program — the budget program or an unknown one — lists like any unknown
         program and stays unblind under the program-authority rule. */
      const intent = decodeSolana(req(compile([emptyIx(program)], version)) as never, FEE_PAYER);
      expect(intent.verifiability).toBe("opaque");
      expect(intent.programs).toStrictEqual([program]);
      expect(intent.blind).toBeUndefined();
    },
  );
});

describe("everyday token and stake instructions decode", () => {
  const SRC = address("So11111111111111111111111111111111111111112");

  const ix = (program: string, accounts: ReadonlyArray<object>, data: Uint8Array) => ({
    programAddress: address(program),
    accounts,
    data,
  });

  it.each([
    ["SPL Token", PROGRAM_IDS.token],
    ["Token-2022", PROGRAM_IDS.token2022],
  ])("an unchecked %s Transfer the signer authorises is described", (_name, program) => {
    const intent = decodeSolana(
      req(
        compile([
          ix(program, [w0(SRC), w0(DEST), sgn(FEE_PAYER)], cat(new Uint8Array([3]), u64le(5n))),
        ]),
      ) as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      {
        to: DEST,
        amount: { asset: SRC, amount: "5" },
        verified: false,
        tokenAccount: SRC,
      },
    ]);
  });

  it.each([
    ["Burn", cat(new Uint8Array([8]), u64le(5n))],
    ["BurnChecked", cat(new Uint8Array([15]), u64le(5n), new Uint8Array([6]))],
  ])("an SPL %s the signer authorises is described as a burn", (_name, data) => {
    const intent = decodeSolana(
      req(compile([ix(PROGRAM_IDS.token, [w0(SRC), ro(MINT), sgn(FEE_PAYER)], data)])) as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      {
        to: SRC,
        amount: { asset: MINT, amount: "5" },
        verified: false,
        burn: true,
      },
    ]);
  });

  it("a Stake Split the staker signs is described", () => {
    const intent = decodeSolana(
      req(
        compile([
          ix(
            PROGRAM_IDS.stake,
            [w0(STAKE_ACCT), w0(DEST), sgn(FEE_PAYER)],
            cat(u32le(3), u64le(7n)),
          ),
        ]),
      ) as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.staking).toStrictEqual([
      { kind: "split", account: STAKE_ACCT, to: DEST, lamports: "7" },
    ]);
  });

  it("a Stake Split whose staker is not the signer is blind", () => {
    const intent = decodeSolana(
      req(
        compile([
          ix(
            PROGRAM_IDS.stake,
            [w0(STAKE_ACCT), w0(DEST), sgn(FEE_PAYER), sgn(OTHER_KEY)],
            cat(u32le(3), u64le(7n)),
          ),
        ]),
      ) as never,
      OTHER_KEY,
    );
    /* decoded for OTHER_KEY's message: the staker in slot 2 is FEE_PAYER, not OTHER_KEY —
       undecoded + the signer takes part ⇒ core-instruction */
    expect(intent.blind).toBe("core-instruction");
  });

  it("a Stake Split naming another staker shows no split action", () => {
    const intent = decodeSolana(
      req(
        compile([
          ix(
            PROGRAM_IDS.stake,
            [w0(STAKE_ACCT), w0(DEST), sgn(OTHER_KEY)],
            cat(u32le(3), u64le(7n)),
          ),
        ]),
      ) as never,
      FEE_PAYER,
    );
    /* The staker is OTHER_KEY, who did not sign this request — the split is not attributed. */
    expect(intent.staking).toBeUndefined();
    expect(intent.blind).toBeUndefined();
  });
});

describe("program-authority: an unknown program taking the signer", () => {
  const DRAINER = "Dra1ner111111111111111111111111111111111111";
  const SRC = address("So11111111111111111111111111111111111111112");
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const ix = (program: string, accounts: ReadonlyArray<object>, data: Uint8Array) => ({
    programAddress: address(program),
    accounts,
    data,
  });

  it("lists the writable accounts it can reach, and whether it can move the SOL", () => {
    const intent = decodeSolana(
      req(
        compile([
          ix(
            DRAINER,
            [sgn(FEE_PAYER), w0(SRC), w0(DEST), ro(PROGRAM_IDS.token)],
            cat(new Uint8Array([0]), u64le(5n)),
          ),
        ]),
      ) as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.verifiability).toBe("opaque");
    expect(intent.programAuthority).toStrictEqual([
      { program: DRAINER, sol: true, accounts: [{ address: SRC }, { address: DEST }] },
    ]);
  });

  it("names a listed mint's ATA as the signer's token account", () => {
    const ata = associatedTokenAddress(FEE_PAYER, USDC_MINT, PROGRAM_IDS.token);
    const intent = decodeSolana(
      req(
        compile([
          ix(DRAINER, [sgn(FEE_PAYER), w0(ata), w0(DEST)], cat(new Uint8Array([0]), u64le(5n))),
        ]),
      ) as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.programAuthority).toStrictEqual([
      {
        program: DRAINER,
        sol: true,
        accounts: [{ address: ata, token: { mint: USDC_MINT, symbol: "USDC" } }, { address: DEST }],
      },
    ]);
  });

  it("a writable address loaded from a lookup table is blind", () => {
    const table = address("AddressLookupTab1e1111111111111111111111111");
    const extra = address("6wWVbLeHDVHvCCsLprB85jkbU1JhS9VezABT2ZZFJ5BB");
    const message = compile(
      [ix(DRAINER, [sgn(FEE_PAYER), w0(extra), w0(SRC)], cat(new Uint8Array([0]), u64le(5n)))],
      0,
      { [table]: [extra] },
    );
    const intent = decodeSolana(
      {
        kind: "solana.transaction",
        network: MAINNET,
        account: ACCOUNT,
        message,
        lookupTables: [{ address: table, addresses: [extra] }],
      } as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBe("program-authority");
    expect(intent.programAuthority?.[0]?.program).toBe(DRAINER);
  });

  it.each([
    [12, undefined],
    [13, "program-authority"],
  ] as const)("%i writable accounts ⇒ blind %s", (count, blind) => {
    const accounts: Array<ReturnType<typeof w0>> = [sgn(FEE_PAYER)];
    for (let i = 0; i < count; i++) {
      accounts.push(w0(address(solanaAddressFromPublicKey(new Uint8Array(32).fill(i + 1)))));
    }
    const intent = decodeSolana(
      req(compile([ix(DRAINER, accounts, cat(new Uint8Array([0]), u64le(5n)))])) as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBe(blind);
  });

  it("an unknown program that does not take the signer carries no programAuthority", () => {
    const intent = decodeSolana(
      req(
        compile([ix(DRAINER, [w0(SRC), w0(DEST)], cat(new Uint8Array([0]), u64le(5n)))]),
      ) as never,
      FEE_PAYER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.programAuthority).toBeUndefined();
    expect(intent.programs).toStrictEqual([DRAINER]);
  });

  it("the signer's key in a non-signer slot does not take the signer", () => {
    /* The decoder does not reject a duplicated key (the runtime would): index 0 is the signer,
       index 3 the same key again as a non-signer. Both instructions reference only slot 3, so
       neither the program-authority rule nor the core-instruction rule may treat them as
       signer-taking. Byte-built because the kit compiler dedupes repeated keys. */
    const enc = getAddressEncoder();
    const keys = [FEE_PAYER, DRAINER, PROGRAM_IDS.token, FEE_PAYER].map((k) =>
      enc.encode(address(k)),
    );
    const ixs = [
      { program: 1, accounts: [3], data: new Uint8Array([0]) },
      { program: 2, accounts: [3], data: new Uint8Array([0xff]) },
    ];
    const out: number[] = [1, 0, 0, keys.length];
    for (const k of keys) {
      out.push(...k);
    }
    out.push(...enc.encode(BLOCKHASH), ixs.length);
    for (const instruction of ixs) {
      out.push(
        instruction.program,
        instruction.accounts.length,
        ...instruction.accounts,
        instruction.data.length,
        ...instruction.data,
      );
    }
    const intent = decodeSolana(req(Uint8Array.from(out)) as never, FEE_PAYER);
    expect(intent.blind).toBeUndefined();
    expect(intent.programAuthority).toBeUndefined();
    expect(intent.programs).toStrictEqual([DRAINER, PROGRAM_IDS.token]);
  });
});

describe("core-program near misses are blind", () => {
  const SRC = address("So11111111111111111111111111111111111111112");
  const RECENT = "SysvarRecentB1ockHashes11111111111111111111";
  const RENT = "SysvarRent111111111111111111111111111111111";

  const ix = (program: string, accounts: ReadonlyArray<object>, data: Uint8Array) => ({
    programAddress: address(program),
    accounts,
    data,
  });

  it.each([
    [
      "SPL Token SetAuthority",
      ix(
        PROGRAM_IDS.token,
        [w0(SRC), sgn(FEE_PAYER)],
        cat(new Uint8Array([6, 0, 1]), Uint8Array.from(getAddressEncoder().encode(OTHER_KEY))),
      ),
    ],
    [
      "SPL Token ApproveChecked",
      ix(
        PROGRAM_IDS.token,
        [w0(SRC), ro(MINT), ro(DEST), sgn(FEE_PAYER)],
        cat(new Uint8Array([13]), u64le(5n), new Uint8Array([6])),
      ),
    ],
    [
      "SPL Token CloseAccount to a foreign destination",
      ix(PROGRAM_IDS.token, [w0(SRC), w0(OTHER_KEY), sgn(FEE_PAYER)], new Uint8Array([9])),
    ],
    [
      "System Assign",
      ix(
        PROGRAM_IDS.system,
        [w0(FEE_PAYER)],
        cat(u32le(1), Uint8Array.from(getAddressEncoder().encode(OTHER_KEY))),
      ),
    ],
  ])("an undecoded %s the signer signs is blind", (_name, instruction) => {
    const intent = decodeSolana(req(compile([instruction])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBe("core-instruction");
  });

  /** The program a solana row's claim names; the filter above guarantees the surface. */
  const rowProgram = (row: (typeof RECOGNISED_FAMILIES)[number]): keyof typeof PROGRAM_IDS => {
    const { claim } = row;
    if (claim.surface !== "solana.instruction") {
      throw new Error("filtered row is not a solana row");
    }
    return claim.program;
  };

  it("every solana family row blinds a signer-signed near miss of its program", () => {
    const rows = RECOGNISED_FAMILIES.filter((r) => r.claim.surface === "solana.instruction");
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      const instruction = ix(
        PROGRAM_IDS[rowProgram(row)],
        [sgn(FEE_PAYER)],
        new Uint8Array([0xfe, 0xdc]),
      );
      const intent = decodeSolana(req(compile([instruction])) as never, FEE_PAYER);
      expect(intent.blind).toBe("core-instruction");
      expect(intent.programs).toStrictEqual([PROGRAM_IDS[rowProgram(row)]]);
    }
  });

  it("a Token Transfer a different co-signer authorises is opaque, not blind", () => {
    const instruction = ix(
      PROGRAM_IDS.token,
      [w0(SRC), w0(DEST), sgn(OTHER_KEY)],
      cat(new Uint8Array([3]), u64le(5n)),
    );
    const intent = decodeSolana(req(compile([instruction])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
    expect(intent.programs).toStrictEqual([PROGRAM_IDS.token]);
  });

  it("an unknown program the signer signs is opaque and named, not blind", () => {
    const instruction = ix(
      "Vote111111111111111111111111111111111111111",
      [sgn(FEE_PAYER)],
      new Uint8Array([1]),
    );
    const intent = decodeSolana(req(compile([instruction])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
    expect(intent.programs).toStrictEqual(["Vote111111111111111111111111111111111111111"]);
  });

  it.each([
    [
      "System AdvanceNonceAccount",
      ix(PROGRAM_IDS.system, [w0(DEST), ro(RECENT), sgn(FEE_PAYER)], u32le(4)),
    ],
    [
      "SPL Token InitializeAccount",
      ix(PROGRAM_IDS.token, [w0(SRC), ro(MINT), ro(FEE_PAYER), ro(RENT)], new Uint8Array([1])),
    ],
    ["SPL Token Revoke", ix(PROGRAM_IDS.token, [w0(SRC), sgn(FEE_PAYER)], new Uint8Array([5]))],
  ])("a benign %s stays described", (_name, instruction) => {
    const intent = decodeSolana(req(compile([instruction])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("full");
    expect(intent.blind).toBeUndefined();
    expect(intent.outflows).toStrictEqual([]);
  });

  it.each([
    [
      "System AdvanceNonceAccount",
      /* [nonce, authority] — the RecentBlockhashes sysvar is missing. */
      ix(PROGRAM_IDS.system, [w0(DEST), sgn(FEE_PAYER)], u32le(4)),
    ],
    [
      "SPL Token InitializeAccount",
      /* [account, mint, owner] — the rent sysvar is missing. */
      ix(PROGRAM_IDS.token, [w0(SRC), ro(MINT), sgn(FEE_PAYER)], new Uint8Array([1])),
    ],
    [
      "SPL Token Revoke",
      /* [account, owner, extra] — one account too many. */
      ix(PROGRAM_IDS.token, [w0(SRC), sgn(FEE_PAYER), ro(DEST)], new Uint8Array([5])),
    ],
  ])("a %s with the wrong account count the signer signs is blind", (_name, instruction) => {
    const intent = decodeSolana(req(compile([instruction])) as never, FEE_PAYER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBe("core-instruction");
  });

  it("a with-seed create whose base account differs from the data's base is not a stake create", () => {
    /* acc(2) is the base account the program checks; a create naming a different base in its
       data is not the recognised stake-creation shape. */
    const seed = new TextEncoder().encode("stake:0");
    const owner = address(STAKE_PROG);
    const derived = solanaAddressFromPublicKey(
      sha256(
        Uint8Array.from([
          ...getAddressEncoder().encode(FEE_PAYER),
          ...seed,
          ...getAddressEncoder().encode(owner),
        ]),
      ),
    );
    const instruction = ix(
      PROGRAM_IDS.system,
      [sgn(FEE_PAYER), w0(derived), sgn(OTHER_KEY)],
      cat(
        u32le(3),
        Uint8Array.from(getAddressEncoder().encode(FEE_PAYER)),
        u64le(BigInt(seed.length)),
        seed,
        u64le(1_000_000_000n),
        u64le(200n),
        Uint8Array.from(getAddressEncoder().encode(owner)),
      ),
    );
    const intent = decodeSolana(req(compile([instruction])) as never, FEE_PAYER);
    expect(intent.staking).toBeUndefined();
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBe("core-instruction");
  });
});
