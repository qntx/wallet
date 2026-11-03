import { schnorr } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import { HDKey } from "@scure/bip32";
/**
 * Result verification for `chain.sign`: `verifyBitcoinPsbtSignatures` re-checks every signature
 * against the account xpub and `verifyBitcoinMessage` rebuilds the BIP-322 simple transcript. Valid
 * signatures are produced with the module's own signers; a wrong key, a tampered sighash or a
 * missing derivation entry must fail closed.
 */
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction } from "@scure/btc-signer/transaction.js";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { signBitcoinMessage, signBitcoinPsbt } from "../src/bitcoin/sign.ts";
import { verifyBitcoinMessage, verifyBitcoinPsbtSignatures } from "../src/bitcoin/verify.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NETWORK_CAIP = "bip122:000000000019d6689c085ae165831e93";
const auxRand = (n: number): Uint8Array => new Uint8Array(32).fill(n + 1);

const account = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/84'/0'/0'");
const accountTr = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/86'/0'/0'");
const ownKey = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/84'/0'/0'/0/0");
const ownKeyTr = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/86'/0'/0'/0/0");
const PAYEE = Address(NETWORK).decode("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");

/** P2WPKH PSBT spending to the account's own 0/0 key, with the derivation entry attached. */
const p2wpkhPsbt = (): Uint8Array => {
  const target = p2wpkh(ownKey.publicKey!, NETWORK);
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: new Uint8Array(32).fill(3),
    index: 0,
    witnessUtxo: { script: target.script, amount: 100000n },
    bip32Derivation: [
      [
        ownKey.publicKey!,
        { fingerprint: 0xaabbccdd, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] },
      ],
    ],
  });
  tx.addOutput({ script: OutScript.encode(PAYEE), amount: 90000n });
  return tx.toPSBT(0);
};

// P2TR key-path PSBT builder kept for the reported verify case above.
const p2trPsbt = (): Uint8Array => {
  const target = p2tr(ownKeyTr.publicKey!.slice(1), undefined, NETWORK);
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: new Uint8Array(32).fill(4),
    index: 0,
    witnessUtxo: { script: target.script, amount: 100000n },
    tapInternalKey: ownKeyTr.publicKey!.slice(1),
    tapBip32Derivation: [
      [
        ownKeyTr.publicKey!.slice(1),
        {
          der: { fingerprint: 0xaabbccdd, path: [0x80000056, 0x80000000, 0x80000000, 0, 0] },
          hashes: [],
        },
      ],
    ],
  });
  tx.addOutput({ script: OutScript.encode(PAYEE), amount: 90000n });
  return tx.toPSBT(0);
};

describe("verifyBitcoinPsbtSignatures", () => {
  it("verifies a P2WPKH signature made by the account's own key", () => {
    const signed = signBitcoinPsbt(
      p2wpkhPsbt(),
      [{ index: 0, privateKey: ownKey.privateKey! }],
      auxRand,
    );
    expect(
      verifyBitcoinPsbtSignatures(
        signed,
        [0],
        account.publicExtendedKey,
        "btc.bip84",
        NETWORK_CAIP,
      ),
    ).toBe(true);
  });

  // A P2TR key-path signature made by signBitcoinPsbt currently verifies false: the module checks
  // the schnorr signature against the untweaked internal key while the signer tweaks it. Suspected
  // defect in verify.ts — reported, not asserted as correct.

  it("rejects a signature checked against a different account xpub", () => {
    const other = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/84'/0'/1'");
    const signed = signBitcoinPsbt(
      p2wpkhPsbt(),
      [{ index: 0, privateKey: ownKey.privateKey! }],
      auxRand,
    );
    expect(
      verifyBitcoinPsbtSignatures(signed, [0], other.publicExtendedKey, "btc.bip84", NETWORK_CAIP),
    ).toBe(false);
  });

  it("rejects an input whose derivation entry is missing", () => {
    const target = p2wpkh(ownKey.publicKey!, NETWORK);
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: new Uint8Array(32).fill(3),
      index: 0,
      witnessUtxo: { script: target.script, amount: 100000n },
    });
    tx.addOutput({ script: OutScript.encode(PAYEE), amount: 90000n });
    const signed = signBitcoinPsbt(
      tx.toPSBT(0),
      [{ index: 0, privateKey: ownKey.privateKey! }],
      auxRand,
    );
    expect(
      verifyBitcoinPsbtSignatures(
        signed,
        [0],
        account.publicExtendedKey,
        "btc.bip84",
        NETWORK_CAIP,
      ),
    ).toBe(false);
  });

  it("rejects a signature whose sighash no longer matches the transaction", () => {
    const signed = Transaction.fromPSBT(
      signBitcoinPsbt(p2wpkhPsbt(), [{ index: 0, privateKey: ownKey.privateKey! }], auxRand),
    );
    // Graft the signature onto an otherwise-identical tx with a different output amount: the
    // stored signature no longer covers the sighash.
    const tampered = Transaction.fromPSBT(p2wpkhPsbt());
    tampered.updateOutput(0, { amount: 90001n });
    tampered.updateInput(0, { partialSig: signed.getInput(0).partialSig! });
    expect(
      verifyBitcoinPsbtSignatures(
        tampered.toPSBT(0),
        [0],
        account.publicExtendedKey,
        "btc.bip84",
        NETWORK_CAIP,
      ),
    ).toBe(false);
  });

  it("verifies a P2TR key-path signature made by the account's own tweaked key", () => {
    const signed = signBitcoinPsbt(
      p2trPsbt(),
      [{ index: 0, privateKey: ownKeyTr.privateKey! }],
      auxRand,
    );
    expect(
      verifyBitcoinPsbtSignatures(
        signed,
        [0],
        accountTr.publicExtendedKey,
        "btc.bip86",
        NETWORK_CAIP,
      ),
    ).toBe(true);
  });

  // The pre-fix bug: a schnorr signature by the untweaked internal key verified — BIP-341 requires
  // the tweaked output key, so this must fail.
  it.each([
    ["untweaked own key", ownKeyTr.privateKey!],
    ["a different key", ownKey.privateKey!],
  ])("rejects a P2TR signature by the %s", (_label, privateKey) => {
    const tx = Transaction.fromPSBT(p2trPsbt());
    const w = tx.getInput(0).witnessUtxo!;
    const preimage = tx.preimageWitnessV1(0, [w.script], SigHash.DEFAULT, [w.amount]);
    tx.updateInput(0, { tapKeySig: schnorr.sign(preimage, privateKey, auxRand(0)) });
    expect(
      verifyBitcoinPsbtSignatures(
        tx.toPSBT(0),
        [0],
        accountTr.publicExtendedKey,
        "btc.bip86",
        NETWORK_CAIP,
      ),
    ).toBe(false);
  });

  // The input's prevout script is not the p2tr output of the claimed key — the claim lies about
  // the account's ownership even though the signature itself is real.
  it("rejects a P2TR input whose prevout script is not the claimed key's p2tr output", () => {
    const foreign = p2tr(ownKey.publicKey!.slice(1), undefined, NETWORK);
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: new Uint8Array(32).fill(4),
      index: 0,
      witnessUtxo: { script: foreign.script, amount: 100000n },
      tapInternalKey: ownKey.publicKey!.slice(1),
      tapBip32Derivation: [
        [
          ownKeyTr.publicKey!.slice(1),
          {
            der: { fingerprint: 0xaabbccdd, path: [0x80000056, 0x80000000, 0x80000000, 0, 0] },
            hashes: [],
          },
        ],
      ],
    });
    tx.addOutput({ script: OutScript.encode(PAYEE), amount: 90000n });
    const signed = signBitcoinPsbt(
      tx.toPSBT(0),
      [{ index: 0, privateKey: ownKey.privateKey! }],
      auxRand,
    );
    expect(
      verifyBitcoinPsbtSignatures(
        signed,
        [0],
        accountTr.publicExtendedKey,
        "btc.bip86",
        NETWORK_CAIP,
      ),
    ).toBe(false);
  });

  it("rejects a P2TR signature whose sighash no longer matches the transaction", () => {
    const signed = Transaction.fromPSBT(
      signBitcoinPsbt(p2trPsbt(), [{ index: 0, privateKey: ownKeyTr.privateKey! }], auxRand),
    );
    const tampered = Transaction.fromPSBT(p2trPsbt());
    tampered.updateOutput(0, { amount: 90001n });
    tampered.updateInput(0, { tapKeySig: signed.getInput(0).tapKeySig! });
    expect(
      verifyBitcoinPsbtSignatures(
        tampered.toPSBT(0),
        [0],
        accountTr.publicExtendedKey,
        "btc.bip86",
        NETWORK_CAIP,
      ),
    ).toBe(false);
  });

  it("rejects an unsigned or malformed PSBT and a bad xpub", () => {
    expect(
      verifyBitcoinPsbtSignatures(
        p2wpkhPsbt(),
        [0],
        account.publicExtendedKey,
        "btc.bip84",
        NETWORK_CAIP,
      ),
    ).toBe(false);
    expect(
      verifyBitcoinPsbtSignatures(
        new Uint8Array([1, 2]),
        [0],
        account.publicExtendedKey,
        "btc.bip84",
        NETWORK_CAIP,
      ),
    ).toBe(false);
  });
});

describe("verifyBitcoinMessage (BIP-322 simple)", () => {
  const signWith = (node: HDKey, addr: string, message: string): string =>
    signBitcoinMessage(
      { network: NETWORK_CAIP, address: addr, message, format: "bip322-simple" },
      node.privateKey!,
      auxRand,
    );

  it("verifies a P2WPKH BIP-322 signature", () => {
    const addr = p2wpkh(ownKey.publicKey!, NETWORK).address;
    const sig = signWith(ownKey, addr, "hello bip322");
    expect(verifyBitcoinMessage(addr, "hello bip322", sig, NETWORK_CAIP)).toBe(true);
  });

  it("verifies a P2TR BIP-322 signature", () => {
    const addr = p2tr(ownKeyTr.publicKey!.slice(1), undefined, NETWORK).address;
    const sig = signWith(ownKeyTr, addr, "hello taproot");
    expect(verifyBitcoinMessage(addr, "hello taproot", sig, NETWORK_CAIP)).toBe(true);
  });

  it("rejects a different address, a tampered message and a bad encoding", () => {
    const addr = p2wpkh(ownKey.publicKey!, NETWORK).address;
    const other = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/84'/0'/0'/0/9");
    const otherAddr = p2wpkh(other.publicKey!, NETWORK).address;
    const sig = signWith(ownKey, addr, "hello bip322");
    expect(verifyBitcoinMessage(otherAddr, "hello bip322", sig, NETWORK_CAIP)).toBe(false);
    expect(verifyBitcoinMessage(addr, "HELLO bip322", sig, NETWORK_CAIP)).toBe(false);
    expect(verifyBitcoinMessage(addr, "hello bip322", "not-base64!!", NETWORK_CAIP)).toBe(false);
    expect(
      verifyBitcoinMessage(addr, "hello bip322", base64.encode(new Uint8Array([1])), NETWORK_CAIP),
    ).toBe(false);
  });
});
