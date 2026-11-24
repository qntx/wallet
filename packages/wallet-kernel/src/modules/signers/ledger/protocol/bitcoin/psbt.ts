/**
 * PSBT → merkleized-map splitting for SIGN_PSBT (doc/bitcoin.md "SIGN_PSBT", doc/merkle.md
 * "Merkleized maps"). Any PSBT version is normalized through @scure/btc-signer —
 * `Transaction.fromPSBT` with unknown/proprietary fields kept (`ignore` policy) and script checks
 * off so every field the device validates survives — then `toPSBT(2)`, and the v2 wire form is
 * split into raw key/value maps: records `varint keyLen ‖ key ‖ varint valLen ‖ value` separated by
 * 0x00 (BIP-174/370) — or, when the input is already v2, split directly so unknown/proprietary
 * pairs survive untouched. The map-commitment layout mirrors the reference MerkelizedPsbt/MerkleMap
 * (bitcoin_client_js/src/lib/{merkelizedPsbt,merkleMap}.ts).
 */
import { Transaction } from "@scure/btc-signer/transaction.js";

import { input, Reader, varint } from "../bytes.ts";
import { LedgerError } from "../errors.ts";
import { leafHash, merkleRoot } from "./merkle.ts";

export type KeyValue = { readonly key: Uint8Array; readonly value: Uint8Array };

export type PsbtV2Maps = {
  readonly global: ReadonlyArray<KeyValue>;
  readonly inputs: ReadonlyArray<ReadonlyArray<KeyValue>>;
  readonly outputs: ReadonlyArray<ReadonlyArray<KeyValue>>;
};

const MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff); // "psbt\xff"
// BIP-370 global keys: PSBT_GLOBAL_INPUT_COUNT / PSBT_GLOBAL_OUTPUT_COUNT / PSBT_GLOBAL_VERSION.
const KEY_INPUT_COUNT = 0x04;
const KEY_OUTPUT_COUNT = 0x05;
const KEY_VERSION = 0xfb;

const invalid = (message: string): LedgerError => input(message);

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const compareKeys = (a: Uint8Array, b: Uint8Array): number => {
  const av = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const d = av.getUint8(i) - bv.getUint8(i);
    if (d !== 0) {
      return d;
    }
  }
  return a.length - b.length;
};

/** Keys must be sorted and unique within a map (doc/merkle.md "Merkleized maps"). */
const sortMap = (kvs: ReadonlyArray<KeyValue>): ReadonlyArray<KeyValue> => {
  const sorted = [...kvs].sort((x, y) => compareKeys(x.key, y.key));
  let prev: Uint8Array | undefined;
  for (const kv of sorted) {
    if (prev !== undefined && equalBytes(prev, kv.key)) {
      throw invalid("a PSBT map has a duplicate key");
    }
    prev = kv.key;
  }
  return sorted;
};

/** A CompactSize-encoded number stored as a standalone value (inputCount/outputCount). */
const countValue = (global: ReadonlyArray<KeyValue>, type: number): number => {
  const hit = global.find((kv) => kv.key.length === 1 && kv.key[0] === type);
  if (hit === undefined) {
    throw invalid("the PSBTv2 global map lacks a required count field");
  }
  try {
    const reader = new Reader(hit.value);
    const count = reader.varint();
    reader.end();
    return count;
  } catch {
    throw invalid("a PSBTv2 count field is not a varint");
  }
};

/** Split the raw `psbt‖…‖0x00` stream into maps; every malformed byte is `invalid-input`. */
const splitMaps = (v2: Uint8Array): { maps: KeyValue[][]; global: ReadonlyArray<KeyValue> } => {
  const reader = new Reader(v2);
  const maps: KeyValue[][] = [];
  try {
    if (!equalBytes(reader.bytes(5), MAGIC)) {
      throw invalid("the PSBTv2 stream has no magic prefix");
    }
    let map: KeyValue[] = [];
    while (reader.remaining > 0) {
      const keyLength = reader.varint();
      if (keyLength === 0) {
        maps.push(map);
        map = [];
        continue;
      }
      const key = reader.bytes(keyLength);
      const valueLength = reader.varint();
      map.push({ key, value: reader.bytes(valueLength) });
    }
    if (map.length > 0) {
      throw invalid("the last PSBT map is not terminated");
    }
  } catch (error) {
    if (error instanceof LedgerError && error.code === "invalid-input") {
      throw error;
    }
    throw invalid("the PSBTv2 stream is malformed");
  }
  const [global] = maps;
  if (global === undefined) {
    throw invalid("the PSBTv2 stream has no global map");
  }
  return { maps, global: sortMap(global) };
};

/** PSBT_GLOBAL_VERSION is a 4-byte little-endian number (BIP-370); absent on v0/v1. */
const versionOf = (global: ReadonlyArray<KeyValue>): number | undefined => {
  const hit = global.find((kv) => kv.key.length === 1 && kv.key[0] === KEY_VERSION);
  if (hit === undefined || hit.value.length !== 4) {
    return undefined;
  }
  return new DataView(hit.value.buffer, hit.value.byteOffset, 4).getUint32(0, true);
};

/**
 * The global, per-input and per-output raw maps of `psbt`, each sorted by key bytes. A stream that
 * is already PSBTv2 keeps its maps verbatim — unknown and proprietary key/value pairs included;
 * anything else is normalized through @scure/btc-signer (v0/v1 → v2), and whatever it cannot decode
 * is `invalid-input`.
 */
const toV2 = (psbt: Uint8Array): Uint8Array => {
  try {
    return Transaction.fromPSBT(psbt, {
      unknown: "ignore",
      proprietary: "ignore",
      allowUnknownVersion: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    }).toPSBT(2);
  } catch {
    throw invalid("the PSBT does not decode or cannot be expressed as version 2");
  }
};

export function psbtV2Maps(psbt: Uint8Array): PsbtV2Maps {
  let parsed: ReturnType<typeof splitMaps> | undefined;
  try {
    parsed = splitMaps(psbt);
  } catch {
    parsed = undefined;
  }
  const { maps, global } =
    parsed !== undefined && versionOf(parsed.global) === 2 ? parsed : splitMaps(toV2(psbt));
  const inputCount = countValue(global, KEY_INPUT_COUNT);
  const outputCount = countValue(global, KEY_OUTPUT_COUNT);
  if (maps.length !== 1 + inputCount + outputCount) {
    throw invalid("the PSBTv2 map count does not match its global counts");
  }
  return {
    global,
    inputs: maps.slice(1, 1 + inputCount).map(sortMap),
    outputs: maps.slice(1 + inputCount).map(sortMap),
  };
}

/**
 * `varint n ‖ merkleRoot(keys) ‖ merkleRoot(values)` — the 65–73 byte commitment of doc/merkle.md
 * (MerkleMap.commitment). `kvs` must already be the sorted map psbtV2Maps returns.
 */
export function mapCommitment(kvs: ReadonlyArray<KeyValue>): Uint8Array {
  const count = varint(kvs.length);
  const out = new Uint8Array(count.length + 64);
  out.set(count, 0);
  out.set(merkleRoot(kvs.map((kv) => leafHash(kv.key))), count.length);
  out.set(merkleRoot(kvs.map((kv) => leafHash(kv.value))), count.length + 32);
  return out;
}
