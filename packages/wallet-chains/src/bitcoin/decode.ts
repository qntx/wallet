import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import { ChainError } from "../index.ts";
import type {
  AssetFlow,
  DisplayIntent,
  IntentWarning,
  SignRequest,
  Verifiability,
} from "../index.ts";
import { withNativeAmountMeta } from "../networks.ts";
import { bitcoinNetwork } from "./networks.ts";
import type { BitcoinOwn } from "./own.ts";
import { EMPTY_BITCOIN_OWN } from "./own.ts";
import { isTaprootInput } from "./psbt.ts";

const SATS = "sats";
const SIGHASH_SINGLE_ANYONECANPAY = 0x83;
const OP_RETURN = 0x6a;
/** Bitcoin Core `CScript::IsUnspendable`: OP_RETURN first, or over MAX_SCRIPT_SIZE. */
const MAX_SCRIPT_SIZE = 10_000;
const unspendable = (script: Uint8Array): boolean =>
  script[0] === OP_RETURN || script.length > MAX_SCRIPT_SIZE;

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

export type BitcoinDisplay = {
  readonly intent: DisplayIntent;
};

/**
 * Decodes a normalized bitcoin.psbt request for display. `own` is the caller's independently
 * verified classification of the account's own-key outputs — `change` script hexes are hidden,
 * `unusual` script hexes become outflows to the caller's own address carrying the path text and one
 * warning each, `unconfirmed` script hexes are plain outflows with a danger warning — not a display
 * hint.
 */
export const decodeBitcoinPsbt = (
  request: Extract<SignRequest, { kind: "bitcoin.psbt" }>,
  own: BitcoinOwn = EMPTY_BITCOIN_OWN,
): DisplayIntent => {
  const tx = parsePsbt(request.psbt);
  const coder = Address(bitcoinNetwork(request.network).params);
  const signed = new Set(request.sign.map((s) => s.index));
  const outflows: AssetFlow[] = [];
  const ownWarnings: IntentWarning[] = [];
  let canFee = true;
  let outSum = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const { script, amount } = tx.getOutput(i);
    if (script === undefined || amount === undefined) {
      throw new ChainError("invalid-request", "PSBT output without script or amount");
    }
    const scriptHex = bytesToHex(script);
    outSum += amount;
    if (own.change.has(scriptHex)) {
      continue;
    }
    if (unspendable(script)) {
      // Value sent to an unspendable output is destroyed — a burn line, not a send.
      if (amount > 0n) {
        outflows.push({
          to: scriptHex,
          amount: { asset: SATS, amount: amount.toString(10) },
          verified: true,
          burn: true,
        });
      }
      continue;
    }
    let addr: string | undefined;
    try {
      const out = OutScript.decode(script);
      addr = out === undefined ? undefined : coder.encode(out);
    } catch {
      addr = undefined;
    }
    const ownPath = own.unusual.get(scriptHex);
    if (ownPath !== undefined) {
      // A verified own-key output the wallet does not discover: named by its path so the user
      // can find the funds — but the wallet may never show them, hence the warning.
      ownWarnings.push({ kind: "unusual-own-output", message: ownPath });
    }
    if (own.unconfirmed.has(scriptHex)) {
      /* The key behind this output sits on an entry the signer never confirmed on the device —
         a plain send line plus a danger warning; never "your own address". */
      ownWarnings.push({
        kind: "unconfirmed-signer-output",
        message: addr ?? scriptHex,
        level: "danger",
      });
    }
    outflows.push({
      to: addr ?? scriptHex,
      amount: { asset: SATS, amount: amount.toString(10) },
      verified: ownPath !== undefined || addr !== undefined,
      ...(ownPath === undefined ? {} : { ownPath }),
    });
  }
  // An input amount is proven only by the full previous transaction — or by a signed taproot
  // input, whose BIP-341 signature commits to every input's amount (sha_amounts) unless it is a
  // listing sighash.
  const amountsCommitted = request.sign.some(
    (s) =>
      isTaprootInput(tx.getInput(s.index)) &&
      tx.getInput(s.index).sighashType !== SIGHASH_SINGLE_ANYONECANPAY,
  );
  let inSum = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const nonWitness = input.nonWitnessUtxo;
    if (nonWitness !== undefined) {
      const prev = input.index === undefined ? undefined : nonWitness.outputs[input.index];
      if (prev === undefined) {
        canFee = false;
      } else {
        inSum += prev.amount;
      }
    } else if (amountsCommitted && input.witnessUtxo !== undefined) {
      inSum += input.witnessUtxo.amount;
    } else {
      canFee = false;
    }
  }
  const external = tx.inputsLength - signed.size > 0;
  const undecodable = outflows.some((o) => !o.verified);
  const listing = request.sign.some(
    (s) => tx.getInput(s.index).sighashType === SIGHASH_SINGLE_ANYONECANPAY,
  );
  // Outputs that exceed the proven inputs can never settle — the request is malformed. A listing
  // (SIGHASH_SINGLE|ANYONECANPAY) skips this: its whole point is that a buyer adds more inputs.
  if (canFee && !listing && inSum < outSum) {
    throw new ChainError("invalid-request", "PSBT outputs exceed its inputs");
  }
  const fee =
    canFee && !listing
      ? { max: { asset: SATS, amount: (inSum - outSum).toString(10) } }
      : undefined;
  const verifiability: Verifiability = external
    ? "opaque"
    : listing || undecodable || fee === undefined
      ? "partial"
      : "full";
  return withNativeAmountMeta(
    {
      family: "bitcoin",
      network: request.network,
      summary: outflows.length > 0 ? "transfer" : "contract-call",
      outflows,
      approvals: [],
      fee,
      warnings: [
        ...ownWarnings,
        ...(listing
          ? [
              {
                kind: "sighash-single-anyonecanpay" as const,
                message:
                  "signed inputs bind only their same-index outputs; the rest of the transaction can change",
              },
            ]
          : []),
      ],
      verifiability,
    },
    request.network,
    SATS,
    8,
  );
};

export const verifiabilityBitcoin = (
  request: Extract<SignRequest, { kind: "bitcoin.psbt" }>,
  own: BitcoinOwn = EMPTY_BITCOIN_OWN,
): Verifiability => decodeBitcoinPsbt(request, own).verifiability;
