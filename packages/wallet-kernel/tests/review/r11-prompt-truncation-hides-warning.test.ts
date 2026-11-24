/**
 * Proof of concept (asserts the current, flawed behaviour): `transactionPrompt` renders the
 * decoder's warning lines LAST in the description, and `boundPrompt` truncates an oversize prompt
 * by keeping a PREFIX of its lines. On the 12-line Android bound, a transaction with enough
 * outflows pushes the `sighash-single-anyonecanpay` warning — the one row that says the signature
 * does not bind the whole transaction — off the device dialog entirely, while the signer still
 * signs.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { CATALOGS, chainPrompt } from "../../src/modules/chains/prompt.ts";
import type { KeystorePrompt } from "../../src/platform.ts";
import { createHarness } from "../harness.ts";
import type { KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";
import type { KeystoreCall } from "../keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const HARDENED = 0x80000000;
const SEED = mnemonicToSeedSync(MNEMONIC);
const MASTER_FP = HDKey.fromMasterSeed(SEED).fingerprint;
const LISTING_SIGHASH = SigHash.SINGLE_ANYONECANPAY;
const WARNING =
  "Signed inputs bind only their same-index outputs; the rest of the transaction can change";

const lastPrompt = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt | undefined =>
  calls.findLast((c): c is KeystoreCall & { prompt?: KeystorePrompt } => "prompt" in c)?.prompt;

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};
const record = (value: ProtocolValue): Record<string, ProtocolValue> => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  return value;
};

const psbtRequest = (
  request: ReturnType<typeof normalizeBitcoin>,
): Parameters<typeof decodeBitcoinPsbt>[0] => {
  if (request.kind !== "bitcoin.psbt") {
    throw new Error("expected a psbt request");
  }
  return request;
};

/**
 * A bip84 spend of `m/84'/0'/0'/0/0` marked SIGHASH_SINGLE|ANYONECANPAY, paying `outputs` foreign
 * p2wpkh scripts — enough send lines to overflow the 12-line Android dialog.
 */
const listingPsbt = (outputs: number): Uint8Array => {
  const inputKey = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'/0/0");
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({
    txid: new Uint8Array(32).fill(0x11),
    index: 0,
    sequence: 0xffffffff,
  });
  prev.addOutput({ script: p2wpkh(inputKey.publicKey!).script, amount: 100_000n });
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xfffffffd,
    sighashType: LISTING_SIGHASH,
    witnessUtxo: { script: p2wpkh(inputKey.publicKey!).script, amount: 100_000n },
    nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [
      [
        inputKey.publicKey!,
        { fingerprint: MASTER_FP, path: [84 + HARDENED, HARDENED, HARDENED, 0, 0] },
      ],
    ],
  });
  for (let i = 0; i < outputs; i++) {
    const script = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xa0 + i)]);
    tx.addOutput({ script, amount: 5000n });
  }
  return tx.toPSBT(0);
};

describe("prompt truncation drops the sighash warning rendered last", () => {
  it("signs a 13-output SIGHASH_SINGLE|ANYONECANPAY spend with the warning cut", async () => {
    /* Android's keystore dialog bounds the prompt at 12 lines / 640 characters. */
    const fake = fakeKeystore("en-US", "android");
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const imported = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = record(imported)["session"] as string;
    const walletId = record(record(imported)["wallet"] as ProtocolValue)["walletId"] as string;
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
    const request = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: { kind: "hd", walletId, groupIndex: 0 },
      psbt: listingPsbt(13),
      sign: [{ index: 0, template: "btc.bip84" }],
    });
    const res = await h.call("chain.sign", { request, verify: { kind: "hardware" } }, session);
    expect("err" in res).toBe(false);
    const prompt = lastPrompt(fake.calls);
    expect(prompt?.title).toBe(CATALOGS.en.blindTitle);
    /* The warning exists in the untruncated rendering of the very same intent. */
    const full = chainPrompt("en", decodeBitcoinPsbt(psbtRequest(request), new Set())).description;
    expect(full).toContain(WARNING);
    /* …and is exactly what the bounded dialog drops. */
    expect(String(prompt?.description)).not.toContain(WARNING);
  });
});
