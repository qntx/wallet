/** `decodeSolanaTransaction`/`addSolanaSignature` over kit-built serialized transactions. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import { signSolanaMessage } from "../src/solana/sign.ts";
import { addSolanaSignature, decodeSolanaTransaction } from "../src/solana/transaction.ts";
import { verifySolanaSignature } from "../src/solana/verify.ts";

const hex = (bytes: Uint8Array | Readonly<Uint8Array>): string =>
  Buffer.from(bytes).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

const WALLET_SEED = new Uint8Array(32).fill(0x07);
const COSIGNER_SEED = new Uint8Array(32).fill(0x09);
const SPONSOR_SEED = new Uint8Array(32).fill(0x0b);
const WALLET = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const COSIGNER = "J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf";
const SPONSOR = "7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9";
const DEST = address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
const SYSTEM = address("11111111111111111111111111111111");
const BLOCKHASH = blockhash("11111111111111111111111111111111");

const transfer = (from: string, lamports: bigint): Instruction => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM,
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: DEST, role: AccountRole.WRITABLE },
    ],
    data,
  };
};

type TestKeyPair = Awaited<ReturnType<typeof createKeyPairFromBytes>>;

const keyPair = async (seed: Uint8Array): Promise<TestKeyPair> =>
  createKeyPairFromBytes(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));

const tx = async (options: {
  version: "legacy" | 0 | 1;
  feePayer: string;
  ixs: ReadonlyArray<Instruction>;
  presignedBy?: TestKeyPair[];
}): Promise<Uint8Array> => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
    setTransactionMessageFeePayer(
      address(options.feePayer),
      createTransactionMessage({ version: options.version }),
    ),
  );
  for (const ix of options.ixs) {
    message = appendTransactionMessageInstruction(ix, message as never);
  }
  const unsigned = compileTransaction(message as never);
  const signed =
    options.presignedBy === undefined
      ? unsigned
      : await partiallySignTransaction(options.presignedBy, unsigned);
  return new Uint8Array(getTransactionEncoder().encode(signed));
};

const verifySlot = (wire: Uint8Array, signer: string): boolean => {
  const decoded = getTransactionDecoder().decode(wire);
  const signature = decoded.signatures[address(signer)];
  return (
    signature !== null &&
    signature !== undefined &&
    verifySolanaSignature(new Uint8Array(decoded.messageBytes), signature, signer)
  );
};

const kitSign = async (wire: Uint8Array, kp: TestKeyPair): Promise<Uint8Array> =>
  new Uint8Array(
    getTransactionEncoder().encode(
      await partiallySignTransaction([kp], getTransactionDecoder().decode(wire)),
    ),
  );

const codeOf = (fn: () => unknown): { code: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error instanceof ChainError
      ? { code: error.code, message: error.message }
      : { code: "other", message: String(error) };
  }
  return { code: "none", message: "" };
};

describe("solana wire transactions", () => {
  it("signs a legacy and a v0 single-signer transaction byte-for-byte like kit", async () => {
    const wallet = await keyPair(WALLET_SEED);
    for (const version of ["legacy", 0] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- deterministic fixtures, one at a time
      const wire = await tx({ version, feePayer: WALLET, ixs: [transfer(WALLET, 1000n)] });
      const { message, unsigned } = decodeSolanaTransaction(wire, WALLET);
      expect(unsigned).toStrictEqual([]);
      const out = addSolanaSignature(wire, WALLET, signSolanaMessage(message, WALLET_SEED));
      // oxlint-disable-next-line eslint/no-await-in-loop -- deterministic fixtures, one at a time
      expect(out).toStrictEqual(await kitSign(wire, wallet));
      expect(verifySlot(out, WALLET)).toBe(true);
    }
  });

  it("keeps a cosigner's signature byte-exact and fills the wallet's slot", async () => {
    const wallet = await keyPair(WALLET_SEED);
    const cosigner = await keyPair(COSIGNER_SEED);
    const wire = await tx({
      version: 0,
      feePayer: WALLET,
      ixs: [transfer(COSIGNER, 1000n)],
      presignedBy: [cosigner],
    });
    const { message, unsigned } = decodeSolanaTransaction(wire, WALLET);
    expect(unsigned).toStrictEqual([]);
    const both = await kitSign(wire, wallet);
    const out = addSolanaSignature(wire, WALLET, signSolanaMessage(message, WALLET_SEED));
    expect(out).toStrictEqual(both);
    const decoded = getTransactionDecoder().decode(out);
    const [slot0, slot1] = Object.keys(decoded.signatures);
    expect(slot0).toBe(WALLET);
    expect(slot1).toBe(COSIGNER);
    expect(decoded.signatures[address(COSIGNER)]).toStrictEqual(
      getTransactionDecoder().decode(wire).signatures[address(COSIGNER)],
    );
  });

  it("signs a sponsored transaction in the wallet's own slot, sponsor untouched", async () => {
    const wallet = await keyPair(WALLET_SEED);
    const sponsor = await keyPair(SPONSOR_SEED);
    const wire = await tx({
      version: 0,
      feePayer: SPONSOR,
      ixs: [transfer(WALLET, 1000n)],
      presignedBy: [sponsor],
    });
    const { message, unsigned } = decodeSolanaTransaction(wire, WALLET);
    expect(unsigned).toStrictEqual([]);
    const out = addSolanaSignature(wire, WALLET, signSolanaMessage(message, WALLET_SEED));
    expect(out).toStrictEqual(await kitSign(wire, wallet));
    const decoded = getTransactionDecoder().decode(out);
    expect(decoded.signatures[address(SPONSOR)]).toStrictEqual(
      getTransactionDecoder().decode(wire).signatures[address(SPONSOR)],
    );
  });

  it("reports the still-unsigned other signers", async () => {
    const wire = await tx({
      version: 0,
      feePayer: WALLET,
      ixs: [transfer(COSIGNER, 1000n)],
    });
    expect(decodeSolanaTransaction(wire, WALLET).unsigned).toStrictEqual([COSIGNER]);
  });

  it("accepts and re-signs a wallet slot that already holds its valid signature", async () => {
    const wallet = await keyPair(WALLET_SEED);
    const wire = await tx({ version: 0, feePayer: WALLET, ixs: [transfer(WALLET, 1000n)] });
    const signed = await kitSign(wire, wallet);
    const { message } = decodeSolanaTransaction(signed, WALLET);
    expect(
      addSolanaSignature(signed, WALLET, signSolanaMessage(message, WALLET_SEED)),
    ).toStrictEqual(signed);
  });

  it("matches the fixed vectors byte for byte", () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../vectors/chains/solana-wire.json"),
        "utf8",
      ),
    );
    const { cases } = raw as {
      cases: Array<{
        name: string;
        secretKey: string;
        signer: string;
        transaction: string;
        message: string;
        signed: string;
      }>;
    };
    for (const c of cases) {
      const { message } = decodeSolanaTransaction(unhex(c.transaction), c.signer);
      expect(hex(message)).toBe(c.message);
      const out = addSolanaSignature(
        unhex(c.transaction),
        c.signer,
        signSolanaMessage(message, unhex(c.secretKey)),
      );
      expect(hex(out)).toBe(c.signed);
    }
  });

  it("rejects a transaction whose slots do not cover the required signers", async () => {
    // A header naming the same signer twice collapses to one key in kit's signature map.
    const a = Uint8Array.from(base58.decode(WALLET));
    const message = new Uint8Array([2, 0, 0, 2, ...a, ...a, ...new Uint8Array(32), 0]);
    const wire = new Uint8Array([2, ...new Uint8Array(128), ...message]);
    const r = codeOf(() => decodeSolanaTransaction(wire, WALLET));
    expect(r.code).toBe("invalid-request");
    expect(r.message).toMatch(/signatures for/);
    // kit itself refuses a wire whose count does not match the header.
    const single = await tx({
      version: "legacy",
      feePayer: WALLET,
      ixs: [transfer(WALLET, 1000n)],
    });
    const shrunk = new Uint8Array([0, ...single.slice(65)]);
    expect(codeOf(() => decodeSolanaTransaction(shrunk, WALLET)).message).toMatch(
      /failed to decode/,
    );
  });

  it("rejects a wallet that is not a required signer, in either role", async () => {
    const wire = await tx({ version: "legacy", feePayer: WALLET, ixs: [transfer(WALLET, 1000n)] });
    expect(codeOf(() => decodeSolanaTransaction(wire, COSIGNER)).message).toMatch(
      /not a required signer/,
    );
    const withNonSigner = await tx({
      version: "legacy",
      feePayer: WALLET,
      ixs: [
        {
          programAddress: SYSTEM,
          accounts: [
            { address: address(WALLET), role: AccountRole.WRITABLE_SIGNER },
            { address: address(COSIGNER), role: AccountRole.READONLY },
          ],
          data: new Uint8Array(12),
        },
      ],
    });
    expect(codeOf(() => decodeSolanaTransaction(withNonSigner, DEST)).message).toMatch(
      /not a required signer/,
    );
  });

  it("rejects a trailing byte and an over-long transaction", async () => {
    const wire = await tx({ version: "legacy", feePayer: WALLET, ixs: [transfer(WALLET, 1000n)] });
    expect(
      codeOf(() => decodeSolanaTransaction(new Uint8Array([...wire, 0]), WALLET)).message,
    ).toMatch(/trailing bytes/);
    const big = new Uint8Array(1233);
    big.set(wire);
    expect(codeOf(() => decodeSolanaTransaction(big, WALLET)).message).toMatch(/1232/);
  });

  it("rejects a non-zero invalid signature in any slot", async () => {
    const cosigner = await keyPair(COSIGNER_SEED);
    const bad = await tx({ version: 0, feePayer: WALLET, ixs: [transfer(WALLET, 1000n)] });
    bad.set(new Uint8Array(64).fill(9), 1);
    expect(codeOf(() => decodeSolanaTransaction(bad, WALLET)).message).toMatch(
      /signature of .* does not verify/,
    );
    const two = await tx({
      version: 0,
      feePayer: WALLET,
      ixs: [transfer(COSIGNER, 1000n)],
      presignedBy: [cosigner],
    });
    two.fill(9, 1 + 64, 1 + 128);
    expect(codeOf(() => decodeSolanaTransaction(two, WALLET)).message).toMatch(
      /signature of .* does not verify/,
    );
  });

  it("rejects a v1 wire as unsupported, plus empty and garbage input", async () => {
    const v1 = await tx({ version: 1, feePayer: WALLET, ixs: [transfer(WALLET, 1000n)] });
    expect(codeOf(() => decodeSolanaTransaction(v1, WALLET)).code).toBe("unsupported");
    expect(codeOf(() => decodeSolanaTransaction(new Uint8Array(0), WALLET)).message).toMatch(
      /failed to decode/,
    );
    expect(
      codeOf(() => decodeSolanaTransaction(new Uint8Array([7, 7, 7]), WALLET)).message,
    ).toMatch(/failed to decode/);
    expect(
      codeOf(() => addSolanaSignature(new Uint8Array(0), WALLET, new Uint8Array(64))).message,
    ).toMatch(/failed to decode/);
  });

  it("rejects a wrong-length signature in addSolanaSignature", async () => {
    const wire = await tx({ version: "legacy", feePayer: WALLET, ixs: [transfer(WALLET, 1000n)] });
    expect(codeOf(() => addSolanaSignature(wire, WALLET, new Uint8Array(63))).message).toMatch(
      /64 bytes/,
    );
  });
});
