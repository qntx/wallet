/**
 * PoC (audit lane parity-multichain, PM-01/PM-02). Wallet Standard `solana:signTransaction` input
 * `transaction` is the *serialized transaction* (`@solana/wallet-standard-features` 1.5.0
 * signTransaction.ts:43 "Serialized transaction, as raw bytes."), i.e. what kit's
 * `getTransactionEncoder()` / web3.js `serialize()` produce: shortvec signature count, 64-byte
 * signature slots, then the message. The engine forwards those bytes unchanged as the compiled
 * *message* (connect/solana.ts:201 → requests/controller.ts:1052 → engine.ts:385).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { normalizeSolana } from "@qntx/wallet-chains/solana";

import { SolanaChainAdapter } from "../../src/chains/solana.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const secret = new Uint8Array(32).fill(7);
const USER = getBase58Decoder().decode(ed25519.getPublicKey(secret));
const COSIGNER = getBase58Decoder().decode(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const ACCOUNT = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change",
} as const;

/** A dApp transaction the way a Wallet Standard dApp hands it over (kit encoder, unsigned). */
const dappTransaction = (extraSigner?: string) => {
  const ixs = [
    getSetComputeUnitLimitInstruction({ units: 200_000 }),
    getTransferSolInstruction({
      source: createNoopSigner(address(USER)),
      destination: address("11111111111111111111111111111112"),
      amount: 1_000n,
    }),
    ...(extraSigner === undefined
      ? []
      : [
          getTransferSolInstruction({
            source: createNoopSigner(address(extraSigner)),
            destination: address(USER),
            amount: 1n,
          }),
        ]),
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(USER), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), lastValidBlockHeight: 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = compileTransaction(message);
  return {
    wire: new Uint8Array(getTransactionEncoder().encode(tx)),
    messageBytes: new Uint8Array(tx.messageBytes),
  };
};

describe("PM-01 Wallet Standard solana:signTransaction bytes", () => {
  it("the engine's normalize accepts message bytes but refuses the spec's serialized transaction", () => {
    const { wire, messageBytes } = dappTransaction();
    const request = (message: Uint8Array) => ({
      kind: "solana.transaction",
      network: NETWORK,
      account: ACCOUNT,
      message,
    });
    // What the engine was tested with: bare message bytes.
    expect(() => normalizeSolana(request(messageBytes), USER)).not.toThrow();
    // What a Wallet Standard dApp actually sends: refused before any prompt.
    expect(() => normalizeSolana(request(wire), USER)).toThrow(/fee payer|message|decode|bytes/i);
    try { normalizeSolana(request(wire), USER); } catch (e) { console.log("PM-01 wire error:", (e as Error).message); }
  });
});

describe("PM-02 multi-signer dApp transactions", () => {
  it("finalize writes one signature slot for a message that needs two, so the output does not decode", () => {
    const { messageBytes } = dappTransaction(COSIGNER);
    // The message is valid for normalize (fee payer = user) …
    expect(() =>
      normalizeSolana(
        { kind: "solana.transaction", network: NETWORK, account: ACCOUNT, message: messageBytes },
        USER,
      ),
    ).not.toThrow();
    // … but the engine's finalize (used by engine.ts:409 for every dApp input) emits sigCount 1.
    const wire = new SolanaChainAdapter().finalize(messageBytes, [new Uint8Array(64).fill(1)]);
    expect(wire[0]).toBe(1);
    expect(messageBytes[1]).toBe(2); // v0 header numRequiredSignatures (byte 0 is the 0x80 prefix)
    expect(() => getTransactionDecoder().decode(wire)).toThrow();
  });
});
