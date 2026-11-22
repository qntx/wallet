/**
 * BIP-322 message signing ("simple" + legacy) built on btc-signer primitives.
 * https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import { ChainError } from "../index.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const BIP322_TAG = "BIP0322-signed-message";
const LEGACY_MAGIC = utf8("Bitcoin Signed Message:\n");

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** CompactSize length prefix for the one-byte form. */
const varint = (n: number): Uint8Array => Uint8Array.of(n);

const COMPACT_SIZE_ONE_BYTE_MAX = 252;

/** A length-prefixed push; longer data would need a multi-byte CompactSize this code never emits. */
export const pushData = (data: Uint8Array): Uint8Array => {
  if (data.length > COMPACT_SIZE_ONE_BYTE_MAX) {
    throw new ChainError("invalid-request", "BIP-322 script data exceeds 252 bytes");
  }
  return concat(varint(data.length), data);
};

const u32le = (n: number): Uint8Array =>
  Uint8Array.of(
    n % 256,
    Math.floor(n / 256) % 256,
    Math.floor(n / 65536) % 256,
    Math.floor(n / 16777216) % 256,
  );

const u64le = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v % 256n);
    v /= 256n;
  }
  return out;
};

/** BIP340 tagged hash: sha256(sha256(tag) || sha256(tag) || m). */
const bip322MessageHash = (message: string): Uint8Array => {
  const tag = sha256(utf8(BIP322_TAG));
  return sha256(concat(tag, tag, utf8(message)));
};

/**
 * Serialized to_spend tx per BIP-322: version 0, one input spending the zero prevout with the
 * message-hash scriptSig, one output paying the message's scriptPubKey. `txid` is the raw hash256d
 * digest — internal byte order, the reverse of the displayed hex.
 */
const toSpend = (
  scriptPubKey: Uint8Array,
  messageHash: Uint8Array,
): { txid: Uint8Array; raw: Uint8Array } => {
  const scriptSig = concat(Uint8Array.of(0x00), pushData(messageHash));
  const raw = concat(
    u32le(0),
    varint(1),
    new Uint8Array(32),
    u32le(0xffffffff),
    pushData(scriptSig),
    u32le(0),
    varint(1),
    u64le(0n),
    pushData(scriptPubKey),
    u32le(0),
  );
  const txid = sha256(sha256(raw));
  return { txid, raw };
};

/**
 * Display-order (big-endian) txid of the BIP-322 to_spend transaction — exported for vector
 * verification.
 */
export const bip322ToSpendTxid = (scriptPubKey: Uint8Array, message: string): Uint8Array =>
  Uint8Array.from([...toSpend(scriptPubKey, bip322MessageHash(message)).txid].reverse());

/**
 * The unsigned BIP-322 to_sign transaction for `scriptPubKey` and `message`: version 0, locktime 0,
 * one input spending `to_spend`'s output 0 (sequence 0, zero-value witness UTXO), one zero-value
 * OP_RETURN output. Signers add signing fields via `updateInput`.
 */
export const bip322ToSign = (scriptPubKey: Uint8Array, message: string): Transaction => {
  const tx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  tx.addInput({
    txid: bip322ToSpendTxid(scriptPubKey, message),
    index: 0,
    sequence: 0,
    witnessUtxo: { script: scriptPubKey, amount: 0n },
  });
  tx.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
  return tx;
};

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64 = (i: number): string => BASE64[i] ?? "";
const base64 = (bytes: Uint8Array): string => {
  const c = b64;
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += c(Math.floor(b0 / 4)) + c((b0 % 4) * 16 + Math.floor(b1 / 16));
    out += i + 1 < bytes.length ? c((b1 % 16) * 4 + Math.floor(b2 / 64)) : "=";
    out += i + 2 < bytes.length ? c(b2 % 64) : "=";
  }
  return out;
};

/**
 * The `smp`-prefixed base64 witness encoding of a BIP-322 simple signature: a count varint then
 * each stack item as a pushData — the finalized P2WPKH `[DER‖sighash, pubkey]` or P2TR `[sig]`.
 */
export const encodeBip322Simple = (witness: ReadonlyArray<Uint8Array>): string => {
  const raw = concat(varint(witness.length), ...witness.map(pushData));
  return `smp${base64(raw)}`;
};

/** The double-SHA256 digest a legacy "Bitcoin Signed Message" signature commits to. */
export const legacyMessageHash = (message: string): Uint8Array =>
  sha256(sha256(concat(pushData(LEGACY_MAGIC), pushData(utf8(message)))));

/**
 * The legacy "Bitcoin Signed Message" compact signature for P2PKH addresses: base64(1-byte header +
 * 64-byte compact ECDSA sig), header = 27 + yParity + 4 (compressed pubkey).
 */
export const encodeLegacySignature = (yParity: 0 | 1, compact: Uint8Array): string =>
  base64(concat(Uint8Array.of(27 + yParity + 4), compact));
