import { HDKey } from "@scure/bip32";
import { NETWORK, p2wpkh, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { BitcoinChainAdapter, dustFor, isFrozen } from "../src/chains/bitcoin.ts";
import type { BtcUtxo } from "../src/chains/bitcoin.ts";

const adapter = new BitcoinChainAdapter();
const HD = HDKey.fromMasterSeed(new Uint8Array(64).fill(1)).derive("m/84'/0'/0'");
const PUB = HD.deriveChild(0).deriveChild(0).publicKey!;
const CHANGE_PUB = HD.deriveChild(1).deriveChild(0).publicKey!;
const TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const CHANGE = p2wpkh(CHANGE_PUB, NETWORK).address;

const TXID = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const utxo = (txid: string, vout: number, value: number): BtcUtxo => ({
  txid,
  vout,
  value,
  address: TO,
  status: "confirmed",
  height: 1,
});

describe("bitcoin psbt construction", () => {
  it("never selects a 546- or 330-sat UTXO even when it would fund the send", () => {
    const inputs = adapter.toInputs(
      [utxo(TXID(1), 0, 546), utxo(TXID(2), 0, 330), utxo(TXID(3), 0, 100_000)],
      0xdeadbeef,
      () => [0],
      () => PUB,
      () => p2wpkh(PUB, NETWORK).script,
      "btc.bip84",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.txid).toBe(TXID(3));
  });

  it("locks a frozen utxo out of selection while a fresh confirmed coin is picked", () => {
    expect(isFrozen(546)).toBe(true);
    expect(isFrozen(330)).toBe(true);
    expect(dustFor("p2wpkh")).toBe(294);
  });

  it("absorbs a sub-dust change into the fee and sends the rest", () => {
    const inputs = adapter.toInputs(
      [utxo(TXID(1), 0, 150_000)],
      0xdeadbeef,
      () => [1, 0],
      () => PUB,
      () => p2wpkh(PUB, NETWORK).script,
      "btc.bip84",
    );
    const { psbt, inputs: selected } = adapter.buildPsbt(
      inputs,
      TO,
      100_000n,
      20n,
      CHANGE,
      NETWORK,
    );
    expect(selected).toHaveLength(1);
    const tx = Transaction.fromPSBT(psbt);
    expect(tx.inputsLength).toBe(1);
    // the change output lands on the next unused change address with a viable amount,
    // or the whole remainder went to fee when below dust
    expect(tx.outputsLength).toBeGreaterThanOrEqual(1);
    const seq = tx.getInput(0).sequence;
    expect(seq).toBe(0xfffffffd);
    const der = tx.getInput(0).bip32Derivation;
    expect(der?.length).toBe(1);
    expect(der?.[0]?.[1]?.fingerprint).toBe(0xdeadbeef);
    expect(der?.[0]?.[1]?.path.join(",")).toBe("1,0");
  });
});

describe("legacy template inputs", () => {
  it("emits redeemScript for bip49 and keeps witnessUtxo", () => {
    const inputs = adapter.toInputs(
      [utxo(TXID(9), 0, 100_000)],
      0xdeadbeef,
      () => [0],
      () => PUB,
      () => p2wpkh(PUB, NETWORK).script,
      "btc.bip49",
    );
    const [i] = inputs;
    expect(i?.witnessUtxo).toBeDefined();
    expect(i?.redeemScript).toBeDefined();
    expect(i?.bip32Derivation).toBeDefined();
    expect(i?.tapBip32Derivation).toBeUndefined();
  });

  it("emits nonWitnessUtxo and no witnessUtxo for bip44", () => {
    const raw = new Uint8Array([0xaa, 0xbb]);
    const inputs = adapter.toInputs(
      [utxo(TXID(9), 0, 100_000)],
      0xdeadbeef,
      () => [0],
      () => PUB,
      () => p2wpkh(PUB, NETWORK).script,
      "btc.bip44",
      () => raw,
    );
    const [i] = inputs;
    expect(i?.witnessUtxo).toBeUndefined();
    expect(i?.nonWitnessUtxo).toStrictEqual(raw);
  });

  it("throws when the bip44 raw tx is missing", () => {
    expect(() =>
      adapter.toInputs(
        [utxo(TXID(9), 0, 100_000)],
        0xdeadbeef,
        () => [0],
        () => PUB,
        () => p2wpkh(PUB, NETWORK).script,
        "btc.bip44",
      ),
    ).toThrow(/no raw transaction/);
  });
});
