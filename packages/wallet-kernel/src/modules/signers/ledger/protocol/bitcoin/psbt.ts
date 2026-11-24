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
import { bytesToHex } from "@noble/hashes/utils.js";
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
// BIP-174/371 output keys: PSBT_OUT_BIP32_DERIVATION / PSBT_OUT_SCRIPT / PSBT_OUT_TAP_BIP32_DERIVATION.
const OUT_BIP32_DERIVATION = 0x02;
const OUT_SCRIPT = 0x04;
const OUT_TAP_BIP32_DERIVATION = 0x07;

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

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** One map's wire form: `varint keyLen ‖ key ‖ varint valLen ‖ value` records, then `0x00`. */
const encodeMap = (kvs: ReadonlyArray<KeyValue>): Uint8Array =>
  concat(
    ...kvs.map((kv) => concat(varint(kv.key.length), kv.key, varint(kv.value.length), kv.value)),
    Uint8Array.of(0),
  );

/** The v2 wire form back: `MAGIC ‖ (map ‖ 0x00)×` — the inverse of what psbtV2Maps reads. */
export const encodePsbtV2 = (maps: PsbtV2Maps): Uint8Array =>
  concat(
    MAGIC,
    encodeMap(maps.global),
    ...maps.inputs.map(encodeMap),
    ...maps.outputs.map(encodeMap),
  );

const derivationFingerprint = (kv: KeyValue): Uint8Array | undefined => {
  if (kv.key[0] === OUT_BIP32_DERIVATION) {
    return kv.value.subarray(0, 4);
  }
  if (kv.key[0] === OUT_TAP_BIP32_DERIVATION) {
    // BIP-371: `varint leafHashCount ‖ leafHashes ‖ fingerprint ‖ path`; real counts fit one byte.
    const [count] = kv.value;
    return count === undefined || count >= 0xfd
      ? undefined
      : kv.value.subarray(1 + 32 * count, 1 + 32 * count + 4);
  }
  return undefined;
};

/**
 * The PSBT as the device should see it. app-bitcoin-new hides as change every output carrying a
 * derivation under the wallet's fingerprint on the policy's change chain, with no index bound —
 * while the kernel's own rule shows the unusual entries by address. Strip the wallet's derivation
 * pairs from every output the kernel did not hide as change so the device displays it too; pairs
 * under a foreign fingerprint stay. Output derivations are not signed, so the signatures the device
 * yields are unaffected. `hiddenChange` holds the script hexes the kernel classified.
 */
export const stripUnhiddenDerivations = (
  psbt: Uint8Array,
  hiddenChange: ReadonlySet<string>,
  fingerprint: Uint8Array,
): Uint8Array => {
  const maps = psbtV2Maps(psbt);
  let stripped = false;
  const outputs = maps.outputs.map((kvs) => {
    const script = kvs.find((kv) => kv.key.length === 1 && kv.key[0] === OUT_SCRIPT)?.value;
    if (script === undefined || hiddenChange.has(bytesToHex(script))) {
      return kvs;
    }
    const kept = kvs.filter((kv) => {
      const at = derivationFingerprint(kv);
      return at === undefined || !equalBytes(at, fingerprint);
    });
    stripped ||= kept.length !== kvs.length;
    return kept;
  });
  return stripped ? encodePsbtV2({ global: maps.global, inputs: maps.inputs, outputs }) : psbt;
};

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
