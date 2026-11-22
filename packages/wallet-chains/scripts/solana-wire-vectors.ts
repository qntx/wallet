/// <reference types="node" />
/**
 * Regenerates vectors/chains/solana-wire.json — serialized transactions as a dApp sends them via
 * the Wallet Standard, each with its compiled message and the result of signing it with the
 * wallet's key. Built with @solana/kit 8.5.0 (+ noble/@scure helpers) only, no project imports.
 *
 * Bun scripts/solana-wire-vectors.ts (from packages/wallet-chains)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction, TransactionMessage, TransactionMessageWithFeePayer } from "@solana/kit";

const OUT = resolve(import.meta.dirname, "../../../vectors/chains/solana-wire.json");
const WALLET_SEED = new Uint8Array(32).fill(0x07);
const COSIGNER_SEED = new Uint8Array(32).fill(0x09);
const SPONSOR_SEED = new Uint8Array(32).fill(0x0b);
const BLOCKHASH = blockhash("11111111111111111111111111111111");
const SYSTEM = address("11111111111111111111111111111111");
const DEST = address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");

const hex = (bytes: Uint8Array | Readonly<Uint8Array>): string =>
  Buffer.from(bytes).toString("hex");

const keyPair = async (
  seed: Uint8Array,
): Promise<Awaited<ReturnType<typeof createKeyPairFromBytes>>> =>
  createKeyPairFromBytes(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));

const addrOf = async (seed: Uint8Array): Promise<string> => {
  const pair = await keyPair(seed);
  return getAddressFromPublicKey(pair.publicKey);
};

/** A bare System-program transfer whose `from` must sign. */
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

type Built = { transaction: string; message: string; signed: string };

const build = async (options: {
  version: "legacy" | 0 | 1;
  feePayer: string;
  ixs: ReadonlyArray<Instruction>;
  presignedBy?: Awaited<ReturnType<typeof createKeyPairFromBytes>>;
  wallet: Awaited<ReturnType<typeof createKeyPairFromBytes>>;
}): Promise<Built> => {
  let message: TransactionMessage & TransactionMessageWithFeePayer =
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
      setTransactionMessageFeePayer(
        address(options.feePayer),
        createTransactionMessage({ version: options.version }),
      ),
    );
  for (const ix of options.ixs) {
    message = appendTransactionMessageInstruction(ix, message);
  }
  const unsigned = compileTransaction(message);
  const prepared =
    options.presignedBy === undefined
      ? unsigned
      : await partiallySignTransaction([options.presignedBy], unsigned);
  const wire = new Uint8Array(getTransactionEncoder().encode(prepared));
  const { messageBytes } = getTransactionDecoder().decode(wire);
  const signed = await partiallySignTransaction([options.wallet], prepared);
  return {
    transaction: hex(wire),
    message: hex(new Uint8Array(messageBytes)),
    signed: hex(new Uint8Array(getTransactionEncoder().encode(signed))),
  };
};

const main = async (): Promise<void> => {
  const wallet = await keyPair(WALLET_SEED);
  const cosigner = await keyPair(COSIGNER_SEED);
  const sponsor = await keyPair(SPONSOR_SEED);
  const [walletAddress, cosignerAddress, sponsorAddress] = await Promise.all([
    addrOf(WALLET_SEED),
    addrOf(COSIGNER_SEED),
    addrOf(SPONSOR_SEED),
  ]);
  const secretKey = hex(WALLET_SEED);
  const cases = [
    {
      name: "legacy-single-signer",
      ...(await build({
        version: "legacy",
        feePayer: walletAddress,
        ixs: [transfer(walletAddress, 1000n)],
        wallet,
      })),
    },
    {
      name: "v0-single-signer",
      ...(await build({
        version: 0,
        feePayer: walletAddress,
        ixs: [transfer(walletAddress, 1000n)],
        wallet,
      })),
    },
    {
      name: "v0-cosigner-signed",
      ...(await build({
        version: 0,
        feePayer: walletAddress,
        ixs: [transfer(cosignerAddress, 1000n)],
        presignedBy: cosigner,
        wallet,
      })),
    },
    {
      name: "v0-sponsored",
      ...(await build({
        version: 0,
        feePayer: sponsorAddress,
        ixs: [transfer(walletAddress, 1000n)],
        presignedBy: sponsor,
        wallet,
      })),
    },
    {
      name: "v1-single-signer",
      ...(await build({
        version: 1,
        feePayer: walletAddress,
        ixs: [transfer(walletAddress, 1000n)],
        wallet,
      })),
    },
    {
      name: "v1-cosigner-signed",
      ...(await build({
        version: 1,
        feePayer: walletAddress,
        ixs: [transfer(cosignerAddress, 1000n)],
        presignedBy: cosigner,
        wallet,
      })),
    },
    {
      name: "v1-sponsored",
      ...(await build({
        version: 1,
        feePayer: sponsorAddress,
        ixs: [transfer(walletAddress, 1000n)],
        presignedBy: sponsor,
        wallet,
      })),
    },
  ].map((c) => ({
    name: c.name,
    secretKey,
    signer: walletAddress,
    transaction: c.transaction,
    message: c.message,
    signed: c.signed,
  }));
  const json = {
    source:
      "@solana/kit 8.5.0 — regenerate with `bun scripts/solana-wire-vectors.ts` from packages/wallet-chains",
    cases,
  };
  writeFileSync(OUT, `${JSON.stringify(json, null, 1)}\n`);
  console.log(`wrote ${OUT}`);
};

await main();
