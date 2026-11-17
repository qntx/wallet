/**
 * PoC (audit lane parity-multichain, PM-03). The only inscription/rune protection is the amount
 * heuristic `FROZEN_AMOUNTS = {546, 330}` (chains/bitcoin.ts:22). ord — the reference inscription
 * wallet — creates inscription and rune-mint outputs at `TARGET_POSTAGE = 10_000 sat`
 * (ordinals/ord@1c2c8de src/lib.rs:156; used by inscribe.rs:119, mint.rs:42, split.rs:167). Such
 * an output is (a) selected by the wallet's own coin selection, and (b) raises no risk when a dApp
 * PSBT asks the wallet to sign it away with SIGHASH_ALL.
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, p2tr, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { BitcoinChainAdapter } from "../../src/chains/bitcoin.ts";
import type { BtcUtxo } from "../../src/chains/bitcoin.ts";
import { assessBitcoinPsbts } from "../../src/requests/risk.ts";

const adapter = new BitcoinChainAdapter();
const HD = HDKey.fromMasterSeed(new Uint8Array(64).fill(1)).derive("m/86'/0'/0'");
const XONLY = HD.deriveChild(0).deriveChild(0).publicKey!.slice(1);
const ORDINALS = p2tr(XONLY, undefined, NETWORK).address!; // the `ordinals` address handed to dApps (bip86 0/0)
const CHANGE = p2tr(HD.deriveChild(1).deriveChild(0).publicKey!.slice(1), undefined, NETWORK).address!;
const TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TXID = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const utxo = (txid: string, value: number): BtcUtxo => ({
  txid,
  vout: 0,
  value,
  address: ORDINALS,
  status: "confirmed",
  height: 1,
});

describe("PM-03 inscription protection is blind to ord's default 10,000-sat postage", () => {
  it("own send: a 10,000-sat inscription output on the ordinals address is selected and spent", () => {
    const inputs = adapter.toInputs(
      [utxo(TXID(1), 546), utxo(TXID(2), 10_000), utxo(TXID(3), 9_000)],
      0xdeadbeef,
      () => [0, 0],
      () => XONLY,
      () => p2tr(XONLY, undefined, NETWORK).script,
      "btc.bip86",
    );
    // 546 is frozen; the ord-default 10,000-sat postage is not.
    expect(inputs.map((i) => i.txid)).toStrictEqual([TXID(2), TXID(3)]);
    const { psbt } = adapter.buildPsbt(inputs, TO, 15_000n, 2n, CHANGE, NETWORK);
    const tx = Transaction.fromPSBT(psbt);
    const spent = Array.from({ length: tx.inputsLength }, (_, i) =>
      Buffer.from(tx.getInput(i).txid!).toString("hex"),
    );
    expect(spent).toContain(TXID(2));
  });

  it("dApp PSBT: signing that output away with SIGHASH_ALL raises no inscription finding", () => {
    expect(assessBitcoinPsbts([{ value: 10_000, sigHash: "ALL" }])).toStrictEqual([]);
    // The same input at 546 sat is a `danger` — only the amount differs.
    expect(assessBitcoinPsbts([{ value: 546, sigHash: "ALL" }])).toStrictEqual([
      { code: "bitcoin-inscription-input", level: "danger" },
    ]);
  });
});
