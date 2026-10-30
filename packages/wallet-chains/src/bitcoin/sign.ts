import { Transaction } from "@scure/btc-signer/transaction.js";
import { Address, OutScript } from "@scure/btc-signer/payment.js";
/**
 * /bitcoin/sign — PSBT signing (P2WPKH, P2SH-P2WPKH, P2PKH, P2TR key path) and message signing
 * (BIP-322 simple, legacy). Inputs must already be normalized: the kernel calls `normalizeBitcoin`
 * first. No key caching.
 */

import { ChainError } from "../index.ts";
import { signBip322Simple, signLegacyMessage } from "./message.ts";
import { bitcoinNetwork } from "./networks.ts";

export const signBitcoinPsbt = (
  psbt: Uint8Array,
  inputs: ReadonlyArray<{ index: number; privateKey: Uint8Array }>,
  auxRand: (n: number) => Uint8Array,
): Uint8Array => {
  const tx = Transaction.fromPSBT(psbt);
  for (const { index, privateKey } of inputs) {
    if (privateKey.length !== 32) {
      throw new ChainError("invalid-request", `input ${index}: private key must be 32 bytes`);
    }
    if (!tx.signIdx(privateKey, index, undefined, auxRand(index))) {
      throw new ChainError("invalid-request", `input ${index}: key cannot sign`);
    }
  }
  return tx.toPSBT(0);
};

/** Returns the signature string: `smp…` base64 witness for bip322-simple, compact base64 for legacy. */
export const signBitcoinMessage = (
  request: {
    network: string;
    address: string;
    message: string;
    format: "bip322-simple" | "legacy";
  },
  privateKey: Uint8Array,
  auxRand: (n: number) => Uint8Array,
): string => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
  if (request.format === "legacy") {
    return signLegacyMessage(request.message, privateKey);
  }
  const scriptPubKey = OutScript.encode(
    Address(bitcoinNetwork(request.network).params).decode(request.address),
  );
  return signBip322Simple(request.message, scriptPubKey, privateKey, auxRand);
};
