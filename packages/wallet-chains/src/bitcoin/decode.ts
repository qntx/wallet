import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import { ChainError } from "../index.ts";
import type { AssetFlow, DisplayIntent, SignRequest, Verifiability } from "../index.ts";
import { withNativeAmountMeta } from "../networks.ts";
import { bitcoinNetwork } from "./networks.ts";
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
    const { script, amount } = tx.getOutput(i);
    if (script === undefined || amount === undefined) {
      throw new ChainError("invalid-request", "PSBT output without script or amount");
    }
    const scriptHex = bytesToHex(script);
    outSum += amount;
    if (ownScripts.has(scriptHex)) {
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
    outflows.push({
      to: addr ?? scriptHex,
      amount: { asset: SATS, amount: amount.toString(10) },
      verified: addr !== undefined,
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
    },
    request.network,
    SATS,
    8,
  );
};

export const verifiabilityBitcoin = (
  request: Extract<SignRequest, { kind: "bitcoin.psbt" }>,
  ownScripts: ReadonlySet<string> = new Set(),
): Verifiability => decodeBitcoinPsbt(request, ownScripts).verifiability;
