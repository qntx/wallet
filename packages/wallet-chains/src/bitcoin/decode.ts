import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import { ChainError } from "../index.ts";
import type { AssetFlow, DisplayIntent, SignRequest, Verifiability } from "../index.ts";
import { bitcoinNetwork } from "./networks.ts";

const SATS = "sats";
const SIGHASH_SINGLE_ANYONECANPAY = 0x83;
const OP_RETURN = 0x6a;

/** Btc-signer's parse failures are foreign exceptions — the request is a malformed PSBT. */
const parsePsbt = (psbt: Uint8Array): Transaction => {
  try {
    return Transaction.fromPSBT(psbt);
  } catch (error) {
    throw error instanceof ChainError ? error : new ChainError("invalid-request", "malformed PSBT");
  }
};

const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
};

type DecodedOutput = {
  readonly amount: bigint;
  readonly script: string;
  readonly opReturn: boolean;
};

/** Decodes an output scriptPubKey; OP_RETURN gets an amount-0 display row. */
const decodeOutput = (script: Uint8Array, amount: bigint): DecodedOutput => {
  const hex = bytesToHex(script);
  if (script[0] === OP_RETURN) {
    return { amount, script: hex, opReturn: true };
  }
  return { amount, script: hex, opReturn: false };
};

export type BitcoinDisplay = {
  readonly intent: DisplayIntent;
};

/**
 * Decodes a normalized bitcoin.psbt request for display. `ownScripts` is the set of output script
 * hexes the caller has independently verified as this account's (e.g. the kernel re-deriving
 * change) — not a display hint.
 */
export const decodeBitcoinPsbt = (
  request: Extract<SignRequest, { kind: "bitcoin.psbt" }>,
  ownScripts: ReadonlySet<string> = new Set(),
): DisplayIntent => {
  const tx = parsePsbt(request.psbt);
  const coder = Address(bitcoinNetwork(request.network).params);
  const signed = new Set(request.sign.map((s) => s.index));
  const outflows: AssetFlow[] = [];
  let canFee = true;
  let outSum = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    const { script } = output;
    const { amount } = output;
    if (script === undefined || amount === undefined) {
      continue;
    }
    const decoded = decodeOutput(script, amount);
    outSum += amount;
    if (decoded.opReturn || ownScripts.has(decoded.script)) {
      continue;
    }
    let addr: string | undefined;
    try {
      const out = OutScript.decode(script);
      addr = out === undefined ? undefined : coder.encode(out);
    } catch {
      addr = undefined;
    }
    outflows.push({
      to: addr ?? decoded.script,
      amount: { asset: SATS, amount: amount.toString(10) },
      verified: addr !== undefined,
    });
  }
  let inSum = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (input.witnessUtxo === undefined) {
      canFee = false;
    } else {
      inSum += input.witnessUtxo.amount;
    }
  }
  const external = tx.inputsLength - signed.size > 0;
  const undecodable = outflows.some((o) => !o.verified);
  const listing = request.sign.some(
    (s) => tx.getInput(s.index).sighashType === SIGHASH_SINGLE_ANYONECANPAY,
  );
  const verifiability: Verifiability = external
    ? "opaque"
    : listing || undecodable
      ? "partial"
      : "full";
  return {
    family: "bitcoin",
    network: request.network,
    summary: outflows.length > 0 ? "transfer" : "contract-call",
    outflows,
    approvals: [],
    fee:
      canFee && !listing
        ? { max: { asset: SATS, amount: (inSum - outSum).toString(10) } }
        : undefined,
    warnings: listing
      ? [
          {
            kind: "sighash-single-anyonecanpay",
            message:
              "signed inputs bind only their same-index outputs; the rest of the transaction can change",
          },
        ]
      : [],
    verifiability,
  };
};

export const verifiabilityBitcoin = (
  request: Extract<SignRequest, { kind: "bitcoin.psbt" }>,
  ownScripts: ReadonlySet<string> = new Set(),
): Verifiability => decodeBitcoinPsbt(request, ownScripts).verifiability;
