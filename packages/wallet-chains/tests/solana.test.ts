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
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { getTransferCheckedInstruction as getTransferCheckedInstruction2022 } from "@solana-program/token-2022";
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

import { ChainError } from "../src/index.ts";
import { solanaAddressFromPublicKey } from "../src/solana/ids.ts";
import {
  SOLANA_NATIVE_ASSET,
  decodeSolana,
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
    expect(intent.approvals[0]).toMatchObject({
      kind: "allowance",
      spender: DELEGATE,
      amount: { amount: "5" },
      change: "set",
      unlimited: false,
    });
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
        amount: { asset: SOLANA_NATIVE_ASSET, amount: "2000000000" },
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
        amount: { asset: SOLANA_NATIVE_ASSET, amount: "500000000" },
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
  });

  it("Split/Merge and truncated data → opaque", () => {
    const merge = getMergeInstruction({
      destinationStake: STAKE_ACCT,
      sourceStake: OTHER_KEY,
      stakeAuthority: feePayerSigner,
    });
    expect(decodeSolana(req(compile([merge])) as never, FEE_PAYER).verifiability).toBe("opaque");
    const truncated = stakeIx(
      [{ address: STAKE_ACCT, role: AccountRole.WRITABLE }],
      u32le(0).subarray(0, 3),
    );
    expect(decodeSolana(req(compile([truncated])) as never, FEE_PAYER).verifiability).toBe(
      "opaque",
    );
    const extended = stakeIx(
      [{ address: STAKE_ACCT, role: AccountRole.WRITABLE }, ro(FEE_PAYER), sgn(FEE_PAYER)],
      cat(u32le(5), u64le(0n)),
    );
    expect(decodeSolana(req(compile([extended])) as never, FEE_PAYER).verifiability).toBe("opaque");
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
    /* A system create-account owned by a different program. */
    const otherCreate = getCreateAccountInstruction({
      payer: feePayerSigner,
      newAccount: stakeSigner,
      lamports: 1_000_000_000n,
      space: 8n,
      programAddress: OTHER_KEY,
    });
    expect(opaque([otherCreate])).toBe("opaque");
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
