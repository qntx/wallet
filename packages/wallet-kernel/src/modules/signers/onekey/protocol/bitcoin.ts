import { secp256k1 } from "@noble/curves/secp256k1.js";
/**
 * Bitcoin signing over the OneKey V1 schema. One signing path for every model: the Trezor-style
 * streaming SignTx/TxRequest/TxAck loop (the device pulls each input/output and each previous
 * transaction piece by piece). SignPsbt is deliberately not used: it accepts taproot-only inputs
 * and treats outputs carrying our fingerprint as change without deriving their script (firmware-pro
 * core/src/apps/bitcoin/sign_taproot.py), while SignTx covers taproot key-path on every model
 * (sign_tx/bitcoin.py taproot_only, firmware-classic1s legacy/firmware/signing.c taproot_only).
 *
 * The device rebuilds the transaction itself: outputs not listed as `change` must carry a real
 * address, and every input must be ours — foreign inputs need SLIP-19 ownership proofs, which is
 * out of scope.
 */
import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { NETWORK, TEST_NETWORK, equalBytes } from "@scure/btc-signer/utils.js";

import { supports } from "./device.ts";
import type { DeviceInfo } from "./device.ts";
import { OneKeyError } from "./errors.ts";
import {
  BtcMessageSignature,
  BtcSignMessage,
  BtcSignTx,
  BtcTxAckInput,
  BtcTxAckOutput,
  BtcTxAckPrevInput,
  BtcTxAckPrevMeta,
  BtcTxAckPrevOutput,
  BtcTxRequest,
} from "./messages.ts";
import type {
  BtcPrevInputFields,
  BtcPrevOutputFields,
  BtcPrevTxFields,
  BtcTxInputFields,
  BtcTxOutputFields,
} from "./messages.ts";
import type { Decoded } from "./proto.ts";
import { call } from "./session.ts";
import type { Exchange } from "./session.ts";

const fault = (message: string): OneKeyError => new OneKeyError("device-fault", message);
const invalid = (message: string): OneKeyError => new OneKeyError("invalid-input", message);
const unsupported = (message: string): OneKeyError => new OneKeyError("unsupported", message);

// InputScriptType values the firmware signs (messages-bitcoin.proto).
const SPENDADDRESS = 0;
const SPENDWITNESS = 3;
const SPENDP2SHWITNESS = 4;
const SPENDTAPROOT = 5;
const SIGN_SCRIPT_TYPES: ReadonlySet<number> = new Set([
  SPENDADDRESS,
  SPENDWITNESS,
  SPENDP2SHWITNESS,
  SPENDTAPROOT,
]);

// OutputScriptType PAYTOOPRETURN.
const PAYTOOPRETURN = 3;

// Input script type (sign/change entry) → OutputScriptType on the wire for change outputs.
const CHANGE_OUTPUT_SCRIPT_TYPES = new Map<number, number>([
  [SPENDADDRESS, 0],
  [SPENDWITNESS, 4],
  [SPENDP2SHWITNESS, 5],
  [SPENDTAPROOT, 6],
]);

// TxRequest.RequestType (messages-bitcoin.proto).
const TXINPUT = 0;
const TXOUTPUT = 1;
const TXMETA = 2;
const TXFINISHED = 3;

// The device only produces these sighashes: DEFAULT for taproot, ALL for the rest
// (firmware-pro core/src/apps/bitcoin/sign_tx/bitcoin.py get_hash_type, legacy signing.c).
const SIGHASH_ALL = 1;
const SIGHASH_DEFAULT = 0;

type WireInput = Decoded<BtcTxInputFields>;
type WireOutput = Decoded<BtcTxOutputFields>;

type PrevTx = {
  meta: Decoded<BtcPrevTxFields>;
  inputs: Array<Decoded<BtcPrevInputFields>>;
  outputs: Array<Decoded<BtcPrevOutputFields>>;
};

export type BitcoinSignEntry = {
  index: number;
  path: ReadonlyArray<number>;
  scriptType: number;
};

export type BitcoinPrepared = {
  readonly coinName: string;
  readonly version: number;
  readonly lockTime: number;
  readonly inputs: ReadonlyArray<WireInput>;
  readonly outputs: ReadonlyArray<WireOutput>;
  /** Previous transactions keyed by the bytes we send as prev_hash, hex form. */
  readonly prevTxs: ReadonlyMap<string, PrevTx>;
  /** Sign entries in the order the plan's tasks run (ascending input index). */
  readonly sign: ReadonlyArray<BitcoinSignEntry>;
  /** True for inputs the device signs with schnorr (SPENDTAPROOT). */
  readonly taproot: ReadonlyArray<boolean>;
};

type PrevRawTx = {
  version: number;
  lockTime: number;
  inputs: ReadonlyArray<{
    txid: Uint8Array;
    index: number;
    finalScriptSig?: Uint8Array;
    sequence?: number;
  }>;
  outputs: ReadonlyArray<{ amount: bigint; script: Uint8Array }>;
};

const u64 = (v: bigint): bigint => BigInt.asUintN(64, v);

const need = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) {
    throw invalid(message);
  }
  return value;
};

function checkPath(path: ReadonlyArray<number>): void {
  if (path.length === 0) {
    throw invalid("derivation path is empty");
  }
  for (const element of path) {
    // > uint32 is not checked here: every caller encodes the path as uint32 addressN, which
    // rejects it before any exchange.
    if (!Number.isInteger(element) || element < 0) {
      throw invalid("derivation path element out of range");
    }
  }
}

function prevoutOf(tx: Transaction, i: number): { amount: bigint; script: Uint8Array } {
  const input = tx.getInput(i);
  if (input.witnessUtxo !== undefined) {
    return { amount: input.witnessUtxo.amount, script: input.witnessUtxo.script };
  }
  const prev = input.nonWitnessUtxo as PrevRawTx | undefined;
  const out = prev?.outputs[need(input.index, `input ${i} has no prevout index`)];
  if (out !== undefined) {
    return { amount: out.amount, script: out.script };
  }
  throw invalid(`input ${i} carries no prevout data`);
}

function decodePrevTx(rawTx: PrevRawTx): PrevTx {
  return {
    meta: {
      version: rawTx.version,
      lockTime: rawTx.lockTime,
      inputsCount: rawTx.inputs.length,
      outputsCount: rawTx.outputs.length,
      extraDataLen: 0,
    },
    inputs: rawTx.inputs.map((input) => ({
      prevHash: input.txid,
      prevIndex: input.index,
      scriptSig: input.finalScriptSig ?? new Uint8Array(),
      sequence: input.sequence ?? 0xff_ff_ff_ff,
    })),
    outputs: rawTx.outputs.map((out) => ({
      amount: u64(out.amount),
      scriptPubkey: out.script,
    })),
  };
}

/**
 * Turn a PSBT into the wire plan for the streaming SignTx protocol. Everything the device cannot
 * honor is refused before any exchange: foreign inputs (they need SLIP-19 ownership proofs),
 * sighashes the firmware cannot produce, script types outside its list, missing prevout data,
 * unaddressable outputs, stray OP_RETURNs.
 */
export function bitcoinPrepare(
  psbt: Uint8Array,
  sign: ReadonlyArray<BitcoinSignEntry>,
  network: "mainnet" | "testnet",
  change: ReadonlyArray<BitcoinSignEntry>,
): BitcoinPrepared {
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(psbt);
  } catch {
    throw invalid("PSBT failed to decode");
  }
  const net = network === "testnet" ? TEST_NETWORK : NETWORK;
  const coinName = network === "testnet" ? "Testnet" : "Bitcoin";

  const signByIndex = new Map<number, BitcoinSignEntry>();
  for (const entry of sign) {
    if (!SIGN_SCRIPT_TYPES.has(entry.scriptType)) {
      throw unsupported(`script type ${entry.scriptType} is not signable by the device`);
    }
    checkPath(entry.path);
    if (entry.index >= tx.inputsLength) {
      throw invalid(`sign index ${entry.index} out of range`);
    }
    if (signByIndex.has(entry.index)) {
      throw invalid(`sign index ${entry.index} listed twice`);
    }
    signByIndex.set(entry.index, entry);
  }
  const changeByIndex = new Map<number, BitcoinSignEntry>();
  for (const entry of change) {
    checkPath(entry.path);
    if (entry.index >= tx.outputsLength) {
      throw invalid(`change index ${entry.index} out of range`);
    }
    if (changeByIndex.has(entry.index)) {
      throw invalid(`change index ${entry.index} listed twice`);
    }
    changeByIndex.set(entry.index, entry);
  }

  const inputs: WireInput[] = [];
  const taproot: boolean[] = [];
  const prevTxs = new Map<string, PrevTx>();
  // In a mixed transaction the device verifies EVERY input against its full previous transaction
  // (bitcoin.py step3_verify_inputs); only an all-taproot SignTx skips that check, so only then
  // is a taproot input's witness_utxo enough.
  const taprootOnly =
    tx.inputsLength > 0 &&
    [...signByIndex.values()].every((entry) => entry.scriptType === SPENDTAPROOT);
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const entry = signByIndex.get(i);
    if (entry === undefined) {
      throw unsupported(`input ${i} is foreign (needs an ownership proof)`);
    }
    const taprootInput = entry.scriptType === SPENDTAPROOT;
    const sighash = input.sighashType;
    if (
      !(
        sighash === undefined ||
        sighash === SIGHASH_ALL ||
        (taprootInput && sighash === SIGHASH_DEFAULT)
      )
    ) {
      throw unsupported(`input ${i} uses a sighash the device cannot produce`);
    }
    const prevOut = prevoutOf(tx, i);
    if (input.nonWitnessUtxo === undefined && !taprootOnly) {
      throw unsupported(`input ${i} has no non_witness_utxo for the device to verify`);
    }
    const txid = need(input.txid, `input ${i} has no prev txid`);
    const prevIndex = need(input.index, `input ${i} has no prevout index`);
    if (input.nonWitnessUtxo !== undefined) {
      const key = bytesHex(txid);
      if (!prevTxs.has(key)) {
        prevTxs.set(key, decodePrevTx(input.nonWitnessUtxo));
      }
      // scure's PSBT decode already guarantees the previous transaction covers this outpoint.
      const prevOut = prevTxs.get(key)?.outputs[prevIndex];
      if (
        prevOut !== undefined &&
        input.witnessUtxo !== undefined &&
        (prevOut.amount !== u64(input.witnessUtxo.amount) ||
          !equalBytes(prevOut.scriptPubkey, input.witnessUtxo.script))
      ) {
        throw invalid(`input ${i} witness_utxo disagrees with non_witness_utxo`);
      }
    }
    inputs.push({
      addressN: [...entry.path],
      prevHash: txid,
      prevIndex,
      ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
      scriptType: entry.scriptType,
      amount: u64(prevOut.amount),
    });
    taproot.push(taprootInput);
  }

  let opReturns = 0;
  const outputs: WireOutput[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const changeEntry = changeByIndex.get(i);
    const amount = need(out.amount, `output ${i} has no amount`);
    const script = need(out.script, `output ${i} has no script`);
    if (changeEntry !== undefined) {
      // The wire output carries an OutputScriptType (messages-bitcoin.proto), not the input's
      // InputScriptType: SPENDADDRESS→PAYTOADDRESS, SPENDWITNESS→PAYTOWITNESS,
      // SPENDP2SHWITNESS→PAYTOP2SHWITNESS, SPENDTAPROOT→PAYTOTAPROOT.
      const outputScriptType = CHANGE_OUTPUT_SCRIPT_TYPES.get(changeEntry.scriptType);
      if (outputScriptType === undefined) {
        throw unsupported(`script type ${changeEntry.scriptType} is not a change output type`);
      }
      outputs.push({
        addressN: [...changeEntry.path],
        amount: u64(amount),
        scriptType: outputScriptType,
      });
      continue;
    }
    if (script[0] === 0x6a) {
      opReturns += 1;
      if (opReturns > 1 || amount !== 0n) {
        throw unsupported("output carries an unsupported OP_RETURN");
      }
      outputs.push({
        amount: 0n,
        scriptType: PAYTOOPRETURN,
        opReturnData: script.slice(1),
      });
      continue;
    }
    let address: string;
    try {
      address = Address(net).encode(OutScript.decode(script));
    } catch {
      throw unsupported(`output ${i} script has no address form`);
    }
    outputs.push({ address, amount: u64(amount), scriptType: 0 });
  }

  return {
    coinName,
    version: tx.version,
    lockTime: tx.lockTime,
    inputs,
    outputs,
    prevTxs,
    sign: [...sign].sort((a, b) => a.index - b.index),
    taproot,
  };
}

const bytesHex = (data: Uint8Array): string => {
  let hex = "";
  for (const byte of data) {
    hex += (byte ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
};

const ecdsaToCompact = (der: Uint8Array): Uint8Array => {
  try {
    return secp256k1.Signature.fromBytes(der, "der").toBytes("compact");
  } catch {
    throw fault("ecdsa signature is not strict DER");
  }
};

const schnorrToCompact = (signature: Uint8Array): Uint8Array => {
  if (signature.length !== 64) {
    throw fault("schnorr signature is not 64 bytes");
  }
  return signature;
};

/**
 * Drive the streaming loop: SignTx, then answer each TxRequest with the matching TxAck until
 * TXFINISHED. Returns one 64-byte signature per `sign` entry, in sign order.
 */
export async function signBitcoinTransaction(
  exchange: Exchange,
  info: DeviceInfo,
  prepared: BitcoinPrepared,
): Promise<Uint8Array[]> {
  void info;
  const { inputs, outputs, prevTxs, sign, taproot } = prepared;
  const signatures: Array<Uint8Array | undefined> = inputs.map(() => undefined);
  let prevTotal = 0;
  for (const prev of prevTxs.values()) {
    prevTotal += prev.inputs.length + prev.outputs.length;
  }
  const maxRounds = 8 * (inputs.length + outputs.length + prevTotal) + 32;

  let request = await call(
    exchange,
    {
      def: BtcSignTx,
      value: {
        outputsCount: outputs.length,
        inputsCount: inputs.length,
        coinName: prepared.coinName,
        version: prepared.version,
        lockTime: prepared.lockTime,
      },
    },
    BtcTxRequest,
  );

  for (let round = 0; ; round++) {
    if (round > maxRounds) {
      throw fault("bitcoin signing exceeded the round bound");
    }
    const { serialized } = request;
    if (serialized?.signature !== undefined) {
      const index = serialized.signatureIndex;
      if (index === undefined || index >= inputs.length || signatures[index] !== undefined) {
        throw fault("device returned an unexpected signature index");
      }
      signatures[index] =
        taproot[index] === true
          ? schnorrToCompact(serialized.signature)
          : ecdsaToCompact(serialized.signature);
    }
    if (request.requestType === TXFINISHED) {
      break;
    }
    const { details } = request;
    const index = details?.requestIndex;
    if (details !== undefined && (details.extraDataLen ?? 0) !== 0) {
      throw fault("device requested extra data");
    }
    if (request.requestType === TXINPUT) {
      if (index === undefined) {
        throw fault("device requested an input without an index");
      }
      if (details?.txHash === undefined) {
        const input = inputs[index];
        if (input === undefined) {
          throw fault("device requested an out-of-range input");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
        request = await call(
          exchange,
          { def: BtcTxAckInput, value: { tx: { input } } },
          BtcTxRequest,
        );
      } else {
        const prev = prevTxs.get(bytesHex(details.txHash));
        const input = prev?.inputs[index];
        if (prev === undefined || input === undefined) {
          throw fault("device requested an unknown previous input");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
        request = await call(
          exchange,
          { def: BtcTxAckPrevInput, value: { tx: { input } } },
          BtcTxRequest,
        );
      }
    } else if (request.requestType === TXOUTPUT) {
      if (index === undefined) {
        throw fault("device requested an output without an index");
      }
      if (details?.txHash === undefined) {
        const output = outputs[index];
        if (output === undefined) {
          throw fault("device requested an out-of-range output");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
        request = await call(
          exchange,
          { def: BtcTxAckOutput, value: { tx: { output } } },
          BtcTxRequest,
        );
      } else {
        const prev = prevTxs.get(bytesHex(details.txHash));
        const output = prev?.outputs[index];
        if (prev === undefined || output === undefined) {
          throw fault("device requested an unknown previous output");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
        request = await call(
          exchange,
          { def: BtcTxAckPrevOutput, value: { tx: { output } } },
          BtcTxRequest,
        );
      }
    } else if (request.requestType === TXMETA) {
      // Neither firmware ever asks for the main transaction's metadata — Pro's bitcoin.py and
      // Classic's signing.c always pass a previous/original tx hash, and the main tx meta already
      // went out in SignTx — so a hashless TXMETA is a device fault.
      const txHash = details?.txHash;
      if (txHash === undefined) {
        throw fault("device requested transaction metadata without a hash");
      }
      const prev = prevTxs.get(bytesHex(txHash));
      if (prev === undefined) {
        throw fault("device requested an unknown previous transaction");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
      request = await call(
        exchange,
        { def: BtcTxAckPrevMeta, value: { tx: prev.meta } },
        BtcTxRequest,
      );
    } else {
      throw fault(`device sent unhandled request type ${request.requestType ?? -1}`);
    }
  }
  return sign.map((entry) => {
    const signature = signatures[entry.index];
    if (signature === undefined) {
      throw fault("device finished without a signature for every input");
    }
    return signature;
  });
}

export type BitcoinDisplayRequest =
  | {
      readonly kind: "bitcoin.psbt";
      readonly psbt: Uint8Array;
      readonly network: "mainnet" | "testnet";
      readonly sign: ReadonlyArray<BitcoinSignEntry>;
      readonly change: ReadonlyArray<BitcoinSignEntry>;
    }
  | { readonly kind: "bitcoin.message"; readonly format: "legacy" | "bip322-simple" };

/**
 * Every request `bitcoinPrepare` accepts is rendered field-by-field by the device — each non-change
 * output address and amount plus the fee (firmware-pro core/src/apps/bitcoin/sign_tx/layout.py,
 * classic1s legacy/firmware/signing.c) — so the classification is "clear" for anything preparable,
 * "unsupported" for what it refuses. Messages are always shown in full.
 */
export function bitcoinDisplay(
  info: DeviceInfo,
  request: BitcoinDisplayRequest,
): "clear" | "unsupported" {
  if (request.kind === "bitcoin.message") {
    return request.format === "bip322-simple" && !supports(info, "btc-bip322")
      ? "unsupported"
      : "clear";
  }
  try {
    bitcoinPrepare(request.psbt, request.sign, request.network, request.change);
    return "clear";
  } catch (error) {
    if (error instanceof OneKeyError) {
      return "unsupported";
    }
    throw error;
  }
}

export type BitcoinMessageOptions = {
  format: "legacy" | "bip322-simple";
  scriptType: number;
  network: "mainnet" | "testnet";
};

/**
 * Sign a bitcoin message. `legacy` produces the 65-byte header‖r‖s compact signature and returns
 * r‖s; `bip322-simple` is gated by firmware support (pro ≥ 4.9.3 — SDK api/btc/BTCSignMessage.ts)
 * and returns the single embedded signature.
 */
export async function signBitcoinMessage(
  exchange: Exchange,
  info: DeviceInfo,
  path: ReadonlyArray<number>,
  message: Uint8Array,
  options: BitcoinMessageOptions,
): Promise<Uint8Array> {
  checkPath(path);
  const bip322 = options.format === "bip322-simple";
  if (bip322 && !supports(info, "btc-bip322")) {
    throw unsupported("firmware does not sign BIP-322 messages");
  }
  const response = await call(
    exchange,
    {
      def: BtcSignMessage,
      value: {
        addressN: [...path],
        message,
        coinName: options.network === "testnet" ? "Testnet" : "Bitcoin",
        scriptType: options.scriptType,
        ...(options.format === "legacy" ? { noScriptType: true } : {}),
        ...(bip322 ? { isBip322Simple: true } : {}),
      },
    },
    BtcMessageSignature,
  );
  if (bip322) {
    return extractBip322Signature(response.signature, options.scriptType);
  }
  if (response.signature.length !== 65) {
    throw fault("bitcoin message signature is not 65 bytes");
  }
  return response.signature.slice(1);
}

/**
 * Extract the single signature from a BIP-322 simple witness serialization: P2WPKH carries DER+0x01
 * (→ compact r‖s), P2TR carries a raw 64-byte schnorr (a 65-byte trailing-0x01 form is refused).
 */
function extractBip322Signature(signature: Uint8Array, scriptType: number): Uint8Array {
  // BIP-322 simple signature = witness stack serialization of the toSpend transaction:
  // item-count varint, then per item a length varint + data.
  let offset = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (offset >= signature.length || shift > 28) {
        throw fault("bip322 witness truncated varint");
      }
      const byte = signature[offset] ?? 0;
      offset += 1;
      result += (byte % 128) * 2 ** shift;
      if (byte < 128) {
        return result;
      }
      shift += 7;
    }
  };
  const itemCount = readVarint();
  if (itemCount < 1 || itemCount > 8) {
    throw fault("bip322 signature has no usable stack items");
  }
  const items: Uint8Array[] = [];
  for (let i = 0; i < itemCount; i++) {
    const length = readVarint();
    if (length < 1 || offset + length > signature.length) {
      throw fault("bip322 witness item out of range");
    }
    items.push(signature.slice(offset, offset + length));
    offset += length;
  }
  const [item] = items;
  if (scriptType === SPENDTAPROOT) {
    if (item === undefined || item.length !== 64 || items.length !== 1) {
      throw fault("bip322 schnorr signature is not a single 64-byte item");
    }
    return item;
  }
  // P2WPKH witness stack: [signature(DER+sighash), pubkey].
  if (item === undefined || item.length < 9) {
    throw fault("bip322 signature item is empty");
  }
  return ecdsaToCompact(item.slice(0, -1));
}
