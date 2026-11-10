import { Transaction, getInputType } from "@scure/btc-signer/transaction.js";

import { ChainError } from "../index.ts";
import type { BitcoinTemplate } from "../index.ts";
import { bitcoinNetwork } from "./networks.ts";

/**
 * BIP-32 derivation paths carry a coin type: 0 for mainnet, 1 for every test network. This is what
 * binds PSBT metadata to the requested network — the raw output scripts themselves carry no network
 * marker.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Bip32Derivation values are [pubkey, { fingerprint, path }] tuples; tapBip32Derivation values are
 * { hashes, der: { fingerprint, path } }.
 */
const derivationPaths = (map: unknown): ReadonlyArray<ReadonlyArray<number>> => {
  const entries =
    map instanceof Map
      ? [...map.values()]
      : Array.isArray(map)
        ? map
        : isRecord(map)
          ? Object.values(map)
          : [];
  const paths: number[][] = [];
  for (const entry of entries) {
    const value: unknown = Array.isArray(entry) ? entry[1] : entry;
    if (!isRecord(value)) {
      continue;
    }
    const der = isRecord(value["der"]) ? value["der"] : value;
    const { path } = der;
    if (Array.isArray(path) && path.every((p) => typeof p === "number")) {
      paths.push(path);
    }
  }
  return paths;
};

const checkPaths = (
  paths: ReadonlyArray<ReadonlyArray<number>>,
  where: string,
  coinType: number,
): void => {
  for (const path of paths) {
    if (path.length >= 2 && (path[1] ?? -1) - 0x80000000 !== coinType) {
      throw new ChainError(
        "chain-id-mismatch",
        `${where} derivation coin type is not this network's`,
      );
    }
  }
};

const checkDerivations = (tx: Transaction, coinType: number): void => {
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    checkPaths(derivationPaths(input.bip32Derivation), `input ${i}`, coinType);
    checkPaths(derivationPaths(input.tapBip32Derivation), `input ${i}`, coinType);
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    checkPaths(derivationPaths(output.bip32Derivation), `output ${i}`, coinType);
    checkPaths(derivationPaths(output.tapBip32Derivation), `output ${i}`, coinType);
  }
};

const DEFAULT_SIGHASH = 0;
const SIGHASH_ALL = 1;
/** SIGHASH_SINGLE | ANYONECANPAY — the marketplace listing sighash, the only other one accepted. */
export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

const TEMPLATES: ReadonlySet<string> = new Set([
  "btc.bip44",
  "btc.bip49",
  "btc.bip84",
  "btc.bip86",
]);

export type PsbtSignEntry = { readonly index: number; readonly template: BitcoinTemplate };

const isSignEntry = (value: unknown): value is PsbtSignEntry =>
  isRecord(value) &&
  typeof value["index"] === "number" &&
  Number.isSafeInteger(value["index"]) &&
  value["index"] >= 0 &&
  typeof value["template"] === "string" &&
  TEMPLATES.has(value["template"]);

export const isTaprootInput = (input: ReturnType<Transaction["getInput"]>): boolean =>
  input.tapInternalKey !== undefined || getInputType(input).type === "taproot";

/**
 * Validates and canonicalizes a bitcoin.psbt request (network already checked by the caller). Every
 * non-taproot signed input must carry the full previous transaction: a BIP-143 signature commits
 * only to its own input's amount, so a `witnessUtxo`-only amount is unverifiable. btc-signer checks
 * each `nonWitnessUtxo` hashes to the input's txid and agrees with any `witnessUtxo` present
 * (`strictPrevoutValidation`). The returned `sign` is sorted ascending by index — a normalized
 * request is canonical.
 */
export const normalizeBitcoinPsbt = (
  psbt: Uint8Array,
  sign: unknown,
  network: string,
): { psbt: Uint8Array; sign: ReadonlyArray<PsbtSignEntry> } => {
  const net = bitcoinNetwork(network);
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(psbt, { strictPrevoutValidation: true });
  } catch {
    throw new ChainError("invalid-request", "PSBT failed to decode");
  }
  if (!Array.isArray(sign) || sign.length === 0 || !sign.every(isSignEntry)) {
    throw new ChainError(
      "invalid-request",
      "sign must be a non-empty array of {index, template} entries",
    );
  }
  const sorted = [...sign].sort((a, b) => a.index - b.index);
  const indices = new Set(sorted.map((s) => s.index));
  const last = sorted.at(-1)?.index;
  if (indices.size !== sorted.length || last === undefined || last >= tx.inputsLength) {
    throw new ChainError("invalid-request", "sign must be unique, ascending, and in range");
  }
  checkDerivations(tx, net.coinType);
  for (const { index: idx, template } of sorted) {
    const input = tx.getInput(idx);
    if (input.witnessUtxo === undefined && input.nonWitnessUtxo === undefined) {
      throw new ChainError(
        "invalid-request",
        `input ${idx} carries neither witnessUtxo nor nonWitnessUtxo`,
      );
    }
    // bip86 inputs are taproot: they derive via tapBip32Derivation, the rest via bip32Derivation.
    if (
      template === "btc.bip86"
        ? input.tapBip32Derivation === undefined
        : input.bip32Derivation === undefined
    ) {
      throw new ChainError("invalid-request", `input ${idx} is missing a bip32 derivation`);
    }
    if (template !== "btc.bip86" && input.nonWitnessUtxo === undefined) {
      throw new ChainError("invalid-request", `input ${idx} must carry nonWitnessUtxo`);
    }
    const sighash = input.sighashType;
    const allowed =
      sighash === undefined ||
      sighash === SIGHASH_ALL ||
      (isTaprootInput(input) && sighash === DEFAULT_SIGHASH) ||
      sighash === SIGHASH_SINGLE_ANYONECANPAY;
    if (!allowed) {
      throw new ChainError("unsupported", `input ${idx} uses a non-default sighash`);
    }
    // SIGHASH_SINGLE signs a constant when the same-index output is missing (the legacy bug).
    if (sighash === SIGHASH_SINGLE_ANYONECANPAY && idx >= tx.outputsLength) {
      throw new ChainError(
        "unsupported",
        `input ${idx} uses SIGHASH_SINGLE without a same-index output`,
      );
    }
  }
  return { psbt: tx.toPSBT(0), sign: sorted };
};
