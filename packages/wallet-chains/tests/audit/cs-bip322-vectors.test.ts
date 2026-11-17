/**
 * Audit A1 / chains-signing differential: BIP-322 simple signing and host verification against the
 * official vectors (bitcoin/bips master `bip-0322/basic-test-vectors.json` and
 * `generated-test-vectors.json`, copied to ./fixtures unmodified).
 *
 * The assertions pin the CURRENT (buggy) behaviour: to_sign spends the to_spend txid in internal
 * byte order where btc-signer's `addInput({ txid })` expects display order, so every official
 * signature is rejected and our own to_sign differs from the official to_sign_tx_hash. A fix flips
 * the `.toBe(false)` / `.not` expectations below.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";
import { OutScript, Address } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { bip322ToSpendTxid, signBip322Simple } from "../../src/bitcoin/message.ts";
import { bitcoinNetwork } from "../../src/bitcoin/networks.ts";
import { verifyBitcoinMessage } from "../../src/bitcoin/verify.ts";

const MAIN = "bip122:000000000019d6689c085ae165831e93";
type Simple = {
  message: string;
  private_keys: string[];
  address: string;
  type: string;
  bip322_signatures: string[];
};
type ErrorCase = { description: string; message: string; address: string; signature: string };
const load = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8")) as {
    simple: Simple[];
    error: ErrorCase[];
  };
const basic = load("bip322-basic-test-vectors.json");
const generated = load("bip322-generated-test-vectors.json");
const supported = (t: string) => t === "p2wpkh" || t === "p2tr";
const simple = [...basic.simple, ...generated.simple].filter((v) => supported(v.type));
const wif = (key: string) => createBase58check(sha256).decode(key).slice(1, 33);

describe("CS-BIP322: official vectors", () => {
  it.each(simple.flatMap((v) => v.bip322_signatures.map((s) => [v.type, v.message, v.address, s])))(
    "BUG: the host verifier rejects the official %s signature for %j",
    (_type, message, address, signature) => {
      expect(verifyBitcoinMessage(address, message, signature, MAIN)).toBe(false);
    },
  );

  const toSign = (address: string, message: string, displayOrder: boolean): string => {
    const script = OutScript.encode(Address(bitcoinNetwork(MAIN).params).decode(address));
    const display = bip322ToSpendTxid(script, message);
    const tx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
    tx.addInput({
      // qntx (message.ts signBip322Simple, verify.ts verifyBitcoinMessage) passes internal order.
      txid: displayOrder ? display : Uint8Array.from([...display].reverse()),
      index: 0,
      sequence: 0,
      witnessUtxo: { script, amount: 0n },
    });
    tx.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
    return tx.id;
  };
  const hashes = (
    JSON.parse(
      readFileSync(resolve(import.meta.dirname, "fixtures", "bip322-basic-test-vectors.json"), "utf8"),
    ) as { tx_hashes: Array<{ message: string; address: string; to_sign_tx_hash: string }> }
  ).tx_hashes;
  it.each(hashes.map((h) => [h.message, h]))("BUG: our to_sign txid for %j is not the official one", (_m, h) => {
    const v = h as (typeof hashes)[number];
    expect(toSign(v.address, v.message, false)).not.toBe(v.to_sign_tx_hash);
    // Control: the same construction with the txid in display order reproduces the vector.
    expect(toSign(v.address, v.message, true)).toBe(v.to_sign_tx_hash);
  });

  it.each(simple.filter((v) => v.type === "p2wpkh").map((v) => [v.message, v]))(
    "BUG: our P2WPKH signature for %j is not an official one (and verifies only with our verifier)",
    (_m, v) => {
      const vector = v as Simple;
      const script = OutScript.encode(Address(bitcoinNetwork(MAIN).params).decode(vector.address));
      const ours = signBip322Simple(vector.message, script, wif(vector.private_keys[0] ?? ""), () =>
        new Uint8Array(32),
      );
      expect(vector.bip322_signatures).not.toContain(ours);
      expect(verifyBitcoinMessage(vector.address, vector.message, ours, MAIN)).toBe(true);
    },
  );

  it.each(
    generated.error
      .filter((e) => /simple/.test(e.description) && /p2wpkh|p2tr/.test(e.description))
      .map((e) => [e.description, e]),
  )("rejects: %s", (_d, e) => {
    const c = e as ErrorCase;
    expect(verifyBitcoinMessage(c.address, c.message, c.signature, MAIN)).toBe(false);
  });
});
