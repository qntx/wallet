/**
 * Result verification for `chain.sign`: the host re-checks the kernel's Bitcoin work against the
 * account's xpub — a kernel returning someone else's signature fails closed with `integrity`.
 * `/bitcoin` entry only — no private key material.
 */
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction } from "@scure/btc-signer/transaction.js";

import type { BitcoinAccountTemplate } from "./account.ts";
import { bip322ToSpendTxid } from "./message.ts";
import { bitcoinNetwork } from "./networks.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Derive the child's public key from the account xpub at `change/index` (non-hardened). */
const childPub = (xpub: string, network: string, change: number, index: number): Uint8Array => {
  const child = HDKey.fromExtendedKey(xpub, bitcoinNetwork(network).bip32)
    .deriveChild(change)
    .deriveChild(index);
  if (child.publicKey === null || child.publicKey === undefined) {
    throw new Error("xpub cannot derive this child");
  }
  return child.publicKey;
};

/** Extract `[pubkey, {fingerprint, path}]`-shaped entries from either PSBT derivation map. */
const derivationOf = (
  map: unknown,
): ReadonlyArray<{ pubkey: Uint8Array; path: ReadonlyArray<number> }> => {
  const out: Array<{ pubkey: Uint8Array; path: ReadonlyArray<number> }> = [];
  const readEntry = (key: unknown, value: unknown): void => {
    const der = isRecord(value) && isRecord(value["der"]) ? value["der"] : value;
    const { path } = isRecord(der) ? der : {};
    if (
      key instanceof Uint8Array &&
      Array.isArray(path) &&
      path.every((p) => typeof p === "number")
    ) {
      out.push({ pubkey: key, path });
    }
  };
  if (map instanceof Map) {
    for (const [key, value] of map) {
      readEntry(key, value);
    }
  } else if (Array.isArray(map)) {
    for (const entry of map) {
      if (Array.isArray(entry) && entry.length === 2) {
        readEntry(entry[0], entry[1]);
      }
    }
  }
  return out;
};

/** The non-hardened `{change, index}` tail of a derivation path, if present and valid. */
const tailOf = (path: ReadonlyArray<number>): { change: 0 | 1; index: number } | undefined => {
  const change = path[path.length - 2];
  const index = path[path.length - 1];
  if ((change !== 0 && change !== 1) || index === undefined || index < 0 || index >= 0x80000000) {
    return undefined;
  }
  return { change, index };
};

const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Verify every signature on the inputs listed in `sign` against the account's xpub: the input's
 * derivation entry must claim the child pubkey re-derived from the xpub, and the signature must
 * verify over the input's sighash (BIP-143 partialSig for P2WPKH, tapKeySig for P2TR key path).
 */
export const verifyBitcoinPsbtSignatures = (
  signedPsbt: Uint8Array,
  sign: ReadonlyArray<number>,
  xpub: string,
  template: BitcoinAccountTemplate,
  network: string,
): boolean => {
  try {
    const tx = Transaction.fromPSBT(signedPsbt);
    const taproot = template === "btc.bip86";
    for (const idx of sign) {
      const input = tx.getInput(idx);
      const claimed = derivationOf(
        taproot ? input.tapBip32Derivation : input.bip32Derivation,
      ).find(({ path }) => tailOf(path) !== undefined);
      const tail = claimed === undefined ? undefined : tailOf(claimed.path);
      if (claimed === undefined || tail === undefined) {
        return false;
      }
      const prevout = input.witnessUtxo;
      if (prevout === undefined) {
        return false;
      }
      const pub = childPub(xpub, network, tail.change, tail.index);
      if (taproot) {
        const xonly = pub.slice(1);
        const rawSig = input.tapKeySig;
        if (
          !eq(claimed.pubkey, xonly) ||
          !(rawSig instanceof Uint8Array) ||
          (rawSig.length !== 64 && rawSig.length !== 65)
        ) {
          return false;
        }
        const sighashType = rawSig.length === 65 ? (rawSig[64] ?? SigHash.DEFAULT) : SigHash.DEFAULT;
        const sig = rawSig.slice(0, 64);
        const scripts: Uint8Array[] = [];
        const amounts: bigint[] = [];
        let complete = true;
        for (let i = 0; i < tx.inputsLength; i++) {
          const w = tx.getInput(i).witnessUtxo;
          if (w === undefined) {
            complete = false;
            break;
          }
          scripts.push(w.script);
          amounts.push(w.amount);
        }
        if (!complete || !schnorr.verify(sig, tx.preimageWitnessV1(idx, scripts, sighashType, amounts), xonly)) {
          return false;
        }
      } else {
        const partial = input.partialSig;
        const found = Array.isArray(partial)
          ? partial.find(([p]) => p instanceof Uint8Array && eq(p, pub))
          : undefined;
        const rawSig = Array.isArray(found) && found[1] instanceof Uint8Array ? found[1] : undefined;
        if (!eq(claimed.pubkey, pub) || rawSig === undefined || rawSig.length === 0) {
          return false;
        }
        const sighashType = input.sighashType ?? (rawSig[rawSig.length - 1] ?? SigHash.ALL);
        const sig = rawSig.slice(0, -1);
        const hash = tx.preimageWitnessV0(idx, prevout.script, sighashType, prevout.amount);
        if (!secp256k1.verify(sig, hash, pub, { format: "der", lowS: true })) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Decode = (s: string): Uint8Array | undefined => {
  if (s.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    return undefined;
  }
  const out = new Uint8Array(Math.floor((s.replace(/=+$/, "").length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    if (ch === "=") {
      break;
    }
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out.slice(0, o);
};

/** Deserialize the `smp`-prefixed base64 witness: count + pushData items. */
const witnessOf = (sig: string): ReadonlyArray<Uint8Array> | undefined => {
  if (!sig.startsWith("smp")) {
    return undefined;
  }
  const raw = base64Decode(sig.slice(3));
  if (raw === undefined || raw.length < 1) {
    return undefined;
  }
  const items: Uint8Array[] = [];
  let off = 1;
  for (let i = 0; i < (raw[0] ?? 0); i++) {
    const len = raw[off];
    if (len === undefined || off + 1 + len > raw.length) {
      return undefined;
    }
    items.push(raw.slice(off + 1, off + 1 + len));
    off += 1 + len;
  }
  return off === raw.length ? items : undefined;
};

/**
 * BIP-322 simple verification against an address: rebuild to_spend/to_sign exactly as the signer
 * does, then verify the witness signature (P2WPKH ECDSA / P2TR schnorr) over the input preimage.
 */
export const verifyBitcoinMessage = (
  address: string,
  message: string,
  signatureBase64: string,
  network: string,
): boolean => {
  try {
    const net = bitcoinNetwork(network);
    const scriptPubKey = OutScript.encode(Address(net.params).decode(address));
    const witness = witnessOf(signatureBase64);
    if (witness === undefined || witness.length === 0) {
      return false;
    }
    const tx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
    tx.addInput({
      txid: bip322ToSpendTxid(scriptPubKey, message),
      index: 0,
      sequence: 0,
      witnessUtxo: { script: scriptPubKey, amount: 0n },
    });
    tx.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
    if (scriptPubKey[0] === 0x51) {
      const rawSig = witness[0];
      const xonly = scriptPubKey.slice(2);
      if (rawSig === undefined || xonly.length !== 32 || (rawSig.length !== 64 && rawSig.length !== 65)) {
        return false;
      }
      const sighashType = rawSig.length === 65 ? (rawSig[64] ?? SigHash.DEFAULT) : SigHash.DEFAULT;
      return schnorr.verify(
        rawSig.slice(0, 64),
        tx.preimageWitnessV1(0, [scriptPubKey], sighashType, [0n]),
        xonly,
      );
    }
    const rawSig = witness[0];
    const pub = witness[1];
    if (rawSig === undefined || pub === undefined || pub.length !== 33 || rawSig.length === 0) {
      return false;
    }
    const sighashType = rawSig[rawSig.length - 1] ?? SigHash.ALL;
    return secp256k1.verify(
      rawSig.slice(0, -1),
      tx.preimageWitnessV0(0, scriptPubKey, sighashType, 0n),
      pub,
      { format: "der", lowS: true },
    );
  } catch {
    return false;
  }
};
