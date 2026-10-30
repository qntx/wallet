import { Transaction, getInputType } from "@scure/btc-signer/transaction.js";
import { ChainError } from "../index.ts";
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

const isTaprootInput = (input: ReturnType<Transaction["getInput"]>): boolean =>
  input.tapInternalKey !== undefined || getInputType(input).type === "taproot";

/**
 * Validates and canonicalizes a bitcoin.psbt request (network already checked by the caller).
 * `strictPrevoutValidation` makes btc-signer verify every `nonWitnessUtxo`'s txid against its
 * outpoint.
 */
export const normalizeBitcoinPsbt = (
  psbt: Uint8Array,
  sign: unknown,
  network: string,
): { psbt: Uint8Array; sign: ReadonlyArray<number> } => {
  const net = bitcoinNetwork(network);
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(psbt, { strictPrevoutValidation: true });
  } catch {
    throw new ChainError("invalid-request", "PSBT failed to decode");
  }
  if (
    !Array.isArray(sign) ||
    sign.length === 0 ||
    !sign.every((i) => Number.isSafeInteger(i) && i >= 0)
  ) {
    throw new ChainError("invalid-request", "sign must be a non-empty array of input indices");
  }
  const unique = [...new Set(sign.map(Number))].sort((a, b) => a - b);
  const last = unique.at(-1);
  if (unique.length !== sign.length || last === undefined || last >= tx.inputsLength) {
    throw new ChainError("invalid-request", "sign must be unique, ascending, and in range");
  }
  checkDerivations(tx, net.coinType);
  for (const idx of unique) {
    const input = tx.getInput(idx);
    if (input.witnessUtxo === undefined) {
      throw new ChainError("invalid-request", `input ${idx} is missing witnessUtxo`);
    }
    if (input.bip32Derivation === undefined && input.tapBip32Derivation === undefined) {
      throw new ChainError("invalid-request", `input ${idx} is missing a bip32 derivation`);
    }
    const { type } = getInputType(input);
    if ((type === "legacy" || type === "nonwitness-script") && input.nonWitnessUtxo === undefined) {
      throw new ChainError("invalid-request", `input ${idx} is missing nonWitnessUtxo`);
    }
    const sighash = input.sighashType;
    const allowed =
      sighash === undefined ||
      sighash === SIGHASH_ALL ||
      (isTaprootInput(input) && sighash === DEFAULT_SIGHASH);
    if (!allowed) {
      throw new ChainError("unsupported", `input ${idx} uses a non-default sighash`);
    }
  }
  return { psbt: tx.toPSBT(0), sign: unique };
};
