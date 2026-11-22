/**
 * /bitcoin/plan — the serialisable signing plan of a normalized request. A PSBT plans one task per
 * listed input (key-path P2TR → BIP-340 over the tweaked output key; P2WPKH/P2SH-P2WPKH/P2PKH →
 * ECDSA over the input's sighash preimage); a message plans the BIP-322-simple or legacy signature
 * of the address's key. No key material — do not import ./index.ts (cycle).
 */
import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { getInputType, getPrevOut, SigHash, Transaction } from "@scure/btc-signer/transaction.js";
import { equalBytes, hash160, tagSchnorr, taprootTweakPubkey } from "@scure/btc-signer/utils.js";

import { ChainError } from "../index.ts";
import type { Bip340Task, EcdsaTask, TaskKey } from "../index.ts";
import { bip322ToSign, legacyMessageHash } from "./message.ts";
import { bitcoinNetwork } from "./networks.ts";

export type BitcoinPsbtPlan = {
  readonly kind: "bitcoin.psbt";
  readonly psbt: Uint8Array;
  readonly inputs: ReadonlyArray<{
    readonly index: number;
    /** The 33-byte compressed signing key (the internal key for taproot). */
    readonly publicKey: Uint8Array;
    readonly sighash: number;
  }>;
  readonly tasks: ReadonlyArray<EcdsaTask | Bip340Task>;
};

export type BitcoinMessagePlan = {
  readonly kind: "bitcoin.message";
  readonly format: "bip322-simple" | "legacy";
  /** The 33-byte compressed signing key. */
  readonly publicKey: Uint8Array;
  readonly tasks: readonly [EcdsaTask | Bip340Task];
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const cannotSign = (index: number): ChainError =>
  new ChainError("invalid-request", `input ${index}: key cannot sign`);

/**
 * Btc-signer 2.4.1 keeps the legacy sighash preimage builder TS-private — the same call its own
 * signer makes, used here so no sighash code of ours exists. The dependency version is pinned
 * exactly and the signing vectors guard against drift.
 */
type LegacyPreimage = {
  readonly preimageLegacy: (idx: number, script: Uint8Array, sighash: number) => Uint8Array;
};

const preimageLegacy = (
  tx: Transaction,
  idx: number,
  scriptCode: Uint8Array,
  sighash: number,
): Uint8Array =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above: pinned, vector-guarded
  (tx as unknown as LegacyPreimage).preimageLegacy(idx, scriptCode, sighash);

const prevoutsOf = (tx: Transaction, index: number) => {
  try {
    const prevouts = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      prevouts.push(getPrevOut(tx.getInput(i)));
    }
    return prevouts;
  } catch (error) {
    throw new ChainError("invalid-request", `input ${index}: ${message(error)}`);
  }
};

/** The BIP-340 task of a key-path taproot input, or `key cannot sign`. */
const taprootTask = (
  tx: Transaction,
  index: number,
  input: ReturnType<Transaction["getInput"]>,
  type: ReturnType<typeof getInputType>,
  key: TaskKey,
): Bip340Task => {
  // Script-path fields would produce signatures the kernel never authorized; key path only.
  if (input.tapLeafScript !== undefined || input.tapMerkleRoot !== undefined) {
    throw cannotSign(index);
  }
  const x = key.publicKey.slice(1);
  if (input.tapInternalKey === undefined || !equalBytes(input.tapInternalKey, x)) {
    throw cannotSign(index);
  }
  // btc-signer's parse-time commitment validation binds the prevout to
  // tapInternalKey/tapMerkleRoot, so it is already p2tr of the tweaked key.
  const [outputKey] = taprootTweakPubkey(x, new Uint8Array());
  const prevouts = prevoutsOf(tx, index);
  return {
    scheme: "bip340",
    path: key.path,
    publicKey: outputKey,
    message: tx.preimageWitnessV1(
      index,
      prevouts.map((p) => p.script),
      type.sighash,
      prevouts.map((p) => p.amount),
    ),
    tweak: tagSchnorr("TapTweak", x),
  };
};

/** The ECDSA task of a segwit-v0 or legacy single-key input, or `key cannot sign`. */
const ecdsaTask = (
  tx: Transaction,
  index: number,
  input: ReturnType<Transaction["getInput"]>,
  type: ReturnType<typeof getInputType>,
  key: TaskKey,
): EcdsaTask => {
  const pubHash = hash160(key.publicKey);
  let digest: Uint8Array;
  if (
    type.txType === "segwit" &&
    type.last.type === "wpkh" &&
    equalBytes(type.last.hash, pubHash)
  ) {
    const scriptCode = OutScript.encode({ type: "pkh", hash: type.last.hash });
    let prevOut;
    try {
      prevOut = getPrevOut(input);
    } catch (error) {
      throw new ChainError("invalid-request", `input ${index}: ${message(error)}`);
    }
    digest = tx.preimageWitnessV0(index, scriptCode, type.sighash, prevOut.amount);
  } else if (
    type.txType === "legacy" &&
    type.last.type === "pkh" &&
    equalBytes(type.last.hash, pubHash)
  ) {
    digest = preimageLegacy(tx, index, type.lastScript, type.sighash);
  } else {
    throw cannotSign(index);
  }
  return { scheme: "ecdsa-secp256k1", path: key.path, publicKey: key.publicKey, digest };
};

/**
 * The PSBT plan: one task per `{index, key}` entry, in the given order. The input sighash must be
 * the type's default or SIGHASH_SINGLE|ANYONECANPAY with a same-index output — the allow-list the
 * previous signer applied.
 */
export const planBitcoinPsbt = (
  psbt: Uint8Array,
  inputs: ReadonlyArray<{ readonly index: number; readonly key: TaskKey }>,
): BitcoinPsbtPlan => {
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(psbt);
  } catch {
    throw new ChainError("invalid-request", "PSBT failed to decode");
  }
  const seen = new Set<number>();
  const planInputs: Array<{
    index: number;
    publicKey: Uint8Array;
    sighash: number;
  }> = [];
  const tasks: Array<EcdsaTask | Bip340Task> = [];
  for (const { index, key } of inputs) {
    if (seen.has(index)) {
      throw new ChainError("invalid-request", `input ${index} is listed twice`);
    }
    seen.add(index);
    if (key.publicKey.length !== 33) {
      throw new ChainError("invalid-request", `input ${index}: public key must be 33 bytes`);
    }
    let input: ReturnType<Transaction["getInput"]>;
    let type: ReturnType<typeof getInputType>;
    try {
      input = tx.getInput(index);
      type = getInputType(input);
    } catch (error) {
      throw new ChainError("invalid-request", `input ${index}: ${message(error)}`);
    }
    const { sighash } = type;
    const allowed =
      sighash === type.defaultSighash ||
      (sighash === SigHash.SINGLE_ANYONECANPAY && index < tx.outputsLength);
    if (!allowed) {
      throw new ChainError("unsupported", `input ${index} uses a non-default sighash`);
    }
    tasks.push(
      type.txType === "taproot"
        ? taprootTask(tx, index, input, type, key)
        : ecdsaTask(tx, index, input, type, key),
    );
    planInputs.push({ index, publicKey: key.publicKey, sighash });
  }
  return { kind: "bitcoin.psbt", psbt, inputs: planInputs, tasks };
};

/** The address's decoded output — the plan rejects anything it cannot bind to the key. */
const decodeAddress = (network: string, address: string) => {
  try {
    return Address(bitcoinNetwork(network).params).decode(address);
  } catch {
    throw new ChainError("invalid-address", "address does not belong to this network");
  }
};

const cannotSignAddress = (): ChainError =>
  new ChainError("invalid-request", "key cannot sign this address");

/**
 * The message plan: the address must decode to the key's own output — P2PKH for `legacy`, P2WPKH or
 * the key's tweaked P2TR for `bip322-simple`.
 */
export const planBitcoinMessage = (
  request: {
    readonly network: string;
    readonly address: string;
    readonly message: string;
    readonly format: "bip322-simple" | "legacy";
  },
  key: TaskKey,
): BitcoinMessagePlan => {
  if (key.publicKey.length !== 33) {
    throw new ChainError("invalid-request", "public key must be 33 bytes");
  }
  const decoded = decodeAddress(request.network, request.address);
  const pubHash = hash160(key.publicKey);
  if (request.format === "legacy") {
    if (decoded.type !== "pkh" || !equalBytes(decoded.hash, pubHash)) {
      throw cannotSignAddress();
    }
    return {
      kind: "bitcoin.message",
      format: "legacy",
      publicKey: key.publicKey,
      tasks: [
        {
          scheme: "ecdsa-secp256k1",
          path: key.path,
          publicKey: key.publicKey,
          digest: legacyMessageHash(request.message),
        },
      ],
    };
  }
  const scriptPubKey = OutScript.encode(decoded);
  if (decoded.type === "wpkh" && equalBytes(decoded.hash, pubHash)) {
    const tx = bip322ToSign(scriptPubKey, request.message);
    return {
      kind: "bitcoin.message",
      format: "bip322-simple",
      publicKey: key.publicKey,
      tasks: [
        {
          scheme: "ecdsa-secp256k1",
          path: key.path,
          publicKey: key.publicKey,
          digest: tx.preimageWitnessV0(
            0,
            OutScript.encode({ type: "pkh", hash: decoded.hash }),
            SigHash.ALL,
            0n,
          ),
        },
      ],
    };
  }
  if (decoded.type === "tr") {
    const x = key.publicKey.slice(1);
    const [outputKey] = taprootTweakPubkey(x, new Uint8Array());
    if (equalBytes(decoded.pubkey, outputKey)) {
      const tx = bip322ToSign(scriptPubKey, request.message);
      return {
        kind: "bitcoin.message",
        format: "bip322-simple",
        publicKey: key.publicKey,
        tasks: [
          {
            scheme: "bip340",
            path: key.path,
            publicKey: outputKey,
            message: tx.preimageWitnessV1(0, [scriptPubKey], SigHash.DEFAULT, [0n]),
            tweak: tagSchnorr("TapTweak", x),
          },
        ],
      };
    }
  }
  throw cannotSignAddress();
};
