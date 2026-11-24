import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
/**
 * Synthetic PSBT builders shared by the emulator recorder and the replay tests. Deterministic:
 * every synthetic prev transaction and output script derives only from the fixed inputs.
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { sha256x2 } from "@scure/btc-signer/utils.js";

import { TEST_MNEMONIC } from "./index.ts";

const H = 0x80_00_00_00;
export const BTC_SIGN_SCRIPT_TYPES: Record<number, number> = { 44: 0, 49: 4, 84: 3, 86: 5 };

export const scriptTypeFor = (path: ReadonlyArray<number>): number =>
  BTC_SIGN_SCRIPT_TYPES[(path[0] ?? 0) - H] ?? -1;

const need = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("PSBT input/output field missing");
  }
  return value;
};

/**
 * The mixed-template PSBT: the vector's three non-taproot inputs plus a fourth taproot input
 * spending a synthesized previous transaction that pays the device key's P2TR output.
 */
export const buildMixedPsbt = (
  psbtHex: string,
  taprootInternalKeyHex: string,
): { psbt: Uint8Array; prevTxid: string; prevRaw: Uint8Array } => {
  const srcTx = Transaction.fromPSBT(hexToBytes(psbtHex), { allowUnknownInputs: true });
  const xonly = hexToBytes(taprootInternalKeyHex).slice(1);
  const synthPrev = new Transaction({ version: 2, lockTime: 0 });
  synthPrev.addInput({ txid: "00".repeat(32), index: 0xff_ff_ff_ff, sequence: 0xff_ff_ff_fd });
  synthPrev.addOutput({ script: p2tr(xonly).script, amount: 103000n });
  const prevRaw = synthPrev.toBytes();
  const prevTxid = bytesToHex(sha256x2(prevRaw).toReversed());
  const spend = new Transaction({ version: srcTx.version, lockTime: srcTx.lockTime });
  for (let i = 0; i < 3; i++) {
    const input = srcTx.getInput(i);
    spend.addInput({
      txid: bytesToHex(need(input.txid)),
      index: need(input.index),
      sequence: need(input.sequence),
      nonWitnessUtxo: need(input.nonWitnessUtxo),
    });
  }
  spend.addInput({
    txid: prevTxid,
    index: 0,
    sequence: 0xff_ff_ff_fd,
    nonWitnessUtxo: prevRaw,
    tapInternalKey: xonly,
  });
  for (let i = 0; i < srcTx.outputsLength; i++) {
    const output = srcTx.getOutput(i);
    spend.addOutput({ script: need(output.script), amount: need(output.amount) });
  }
  return { psbt: spend.toPSBT(0), prevTxid, prevRaw };
};

export const CHANGE_PATH: number[] = [H + 84, H, H, 1, 0];

/** One-input P2WPKH spend (vector input 2) with a declared change output at m/84'/0'/0'/1/0. */
export const buildChangePsbt = (
  psbtHex: string,
): { psbt: Uint8Array; paymentScript: Uint8Array; changeScript: Uint8Array } => {
  const srcTx = Transaction.fromPSBT(hexToBytes(psbtHex), { allowUnknownInputs: true });
  const input = srcTx.getInput(2);
  const changeKey = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC)).derive(
    "m/84'/0'/0'/1/0",
  );
  if (changeKey.publicKey === null) {
    throw new Error("failed to derive change key");
  }
  const changeScript = p2wpkh(changeKey.publicKey).script;
  const spend = new Transaction({ version: srcTx.version, lockTime: srcTx.lockTime });
  spend.addInput({
    txid: bytesToHex(need(input.txid)),
    index: need(input.index),
    sequence: need(input.sequence),
    nonWitnessUtxo: need(input.nonWitnessUtxo),
  });
  const payment = srcTx.getOutput(0);
  spend.addOutput({ script: need(payment.script), amount: 50000n });
  spend.addOutput({ script: changeScript, amount: 49000n });
  return { psbt: spend.toPSBT(0), paymentScript: need(payment.script), changeScript };
};
