/**
 * Independent PSBT signature verification shared by the protocol and driver replay tests: sighashes
 * recomputed with bitcoinjs-lib + tiny-secp256k1, ECDSA and BIP-340 verified with noble — no kernel
 * signing code.
 */
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { p2pkh } from "@scure/btc-signer";
import { initEccLib, Psbt, Transaction as BtcJsTransaction } from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";

initEccLib(ecc);

// Bip174 types `unsignedTx` as a minimal interface; at runtime it wraps the real Transaction
// in a `{ tx }` view object.
const unsignedTxOf = (psbt: Psbt): BtcJsTransaction => {
  const view: unknown = psbt.data.globalMap.unsignedTx;
  if (
    typeof view === "object" &&
    view !== null &&
    "tx" in view &&
    view.tx instanceof BtcJsTransaction
  ) {
    return view.tx;
  }
  throw new TypeError("the psbt carries no unsigned transaction");
};

const prevoutScript = (psbtBytes: Uint8Array, i: number): Uint8Array => {
  const psbt = Psbt.fromBuffer(Buffer.from(psbtBytes));
  const tx = unsignedTxOf(psbt);
  const input = psbt.data.inputs[i];
  if (input === undefined) {
    throw new Error(`psbt input ${i} missing`);
  }
  if (input.nonWitnessUtxo !== undefined) {
    const prev = BtcJsTransaction.fromBuffer(Buffer.from(input.nonWitnessUtxo));
    const out = tx.ins[i];
    const prevOut = out === undefined ? undefined : prev.outs[out.index];
    if (prevOut === undefined) {
      throw new Error(`prevout ${i} missing`);
    }
    return prevOut.script;
  }
  throw new Error(`input ${i} has no prevout script`);
};

/** Independent sighash oracle: the PSBT's sighash for input `i`, per its script family. */
export function sighash(psbtBytes: Uint8Array, i: number, publicKey: Uint8Array): Uint8Array {
  const psbt = Psbt.fromBuffer(Buffer.from(psbtBytes));
  const tx = unsignedTxOf(psbt);
  const input = psbt.data.inputs[i];
  if (input === undefined) {
    throw new Error(`psbt input ${i} missing`);
  }
  const prevScriptOf = (idx: number): Uint8Array => {
    const inp = psbt.data.inputs[idx];
    if (inp === undefined) {
      throw new Error(`psbt input ${idx} missing`);
    }
    if (inp.witnessUtxo !== undefined) {
      return inp.witnessUtxo.script;
    }
    if (inp.nonWitnessUtxo !== undefined) {
      const prev = BtcJsTransaction.fromBuffer(Buffer.from(inp.nonWitnessUtxo));
      const out = tx.ins[idx];
      if (out === undefined) {
        throw new Error(`tx input ${idx} missing`);
      }
      const prevOut = prev.outs[out.index];
      if (prevOut === undefined) {
        throw new Error(`prevout ${idx} missing`);
      }
      return prevOut.script;
    }
    throw new Error(`input ${idx} has no prevout`);
  };
  const prevAmountOf = (idx: number): bigint => {
    const inp = psbt.data.inputs[idx];
    if (inp === undefined) {
      throw new Error(`psbt input ${idx} missing`);
    }
    if (inp.witnessUtxo !== undefined) {
      return inp.witnessUtxo.value;
    }
    if (inp.nonWitnessUtxo !== undefined) {
      const prev = BtcJsTransaction.fromBuffer(Buffer.from(inp.nonWitnessUtxo));
      const out = tx.ins[idx];
      if (out === undefined) {
        throw new Error(`tx input ${idx} missing`);
      }
      const prevOut = prev.outs[out.index];
      if (prevOut === undefined) {
        throw new Error(`prevout ${idx} missing`);
      }
      return prevOut.value;
    }
    throw new Error(`input ${idx} has no prevout`);
  };
  const prevScript = prevScriptOf(i);
  const value = prevAmountOf(i);
  const isTaproot = prevScript[0] === 0x51 && prevScript.length === 34;
  if (isTaproot) {
    const scripts = tx.ins.map((_, idx) => prevScriptOf(idx));
    const values = tx.ins.map((_, idx) => prevAmountOf(idx));
    return new Uint8Array(
      tx.hashForWitnessV1(i, scripts, values, BtcJsTransaction.SIGHASH_DEFAULT),
    );
  }
  const isWitness = prevScript[0] === 0x00 || prevScript[0] === 0x51 || prevScript[0] === 0xa9;
  if (isWitness) {
    // BIP143: the scriptCode for a P2WPKH spend is the P2PKH scriptPubKey of the same key
    // hash. A P2SH wrap may not carry a redeemScript (the device derives it from the
    // declared path), so take the key hash from the signing key.
    return new Uint8Array(
      tx.hashForWitnessV0(i, p2pkh(publicKey).script, value, BtcJsTransaction.SIGHASH_ALL),
    );
  }
  return new Uint8Array(tx.hashForSignature(i, prevScript, BtcJsTransaction.SIGHASH_ALL));
}

/** The tweaked x-only key a taproot input's prevout commits to — what BIP-340 verifies under. */
export function sighashTweakedKey(psbtBytes: Uint8Array, i: number): Uint8Array {
  const psbt = Psbt.fromBuffer(Buffer.from(psbtBytes));
  const input = psbt.data.inputs[i];
  const script = input?.witnessUtxo?.script ?? prevoutScript(psbtBytes, i);
  if (script[0] !== 0x51 || script.length !== 34) {
    throw new Error(`input ${i} is not a taproot prevout`);
  }
  return new Uint8Array(script.slice(2));
}

// noble v2 hashes the message internally — `prehash: false` verifies against the raw digest,
// which is what the device signed (the plan digest / recomputed sighash).
export const ecdsaOk = (digest: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean =>
  secp256k1.verify(sig, digest, publicKey, { prehash: false, lowS: false });

export const schnorrOk = (digest: Uint8Array, sig: Uint8Array, tweakedXonly: Uint8Array): boolean =>
  schnorr.verify(sig, digest, tweakedXonly);
