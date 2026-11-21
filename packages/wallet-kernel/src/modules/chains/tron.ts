/** TRON signing for `chain.sign` — derive, normalize, decode, then sign or return the intent. */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";

import type { DisplayIntent } from "@qntx/wallet-chains";
import { decodeTron, normalizeTron, tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import { signTronMessage, signTronTransaction } from "@qntx/wallet-chains/tron/sign";

import { KernelError } from "../../errors.ts";
import type { ExecuteResult, TronKeySource, TronRequest } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

export const executeTron = (
  request: TronRequest,
  source: TronKeySource,
  intentOnly: boolean,
): ExecuteResult => {
  if (source.kind === "imported") {
    /* The record's plaintext is the private key; `chainSign` wipes the opened copy. */
    const priv = source.secret;
    const signer = tronAddressFromPublicKey(secp256k1.getPublicKey(priv, true));
    return tronBody(request, priv, signer, intentOnly);
  }
  const master = HDKey.fromMasterSeed(source.seed);
  try {
    const child = master.derive(`m/44'/195'/0'/0/${source.account.groupIndex}`);
    try {
      const priv = child.privateKey;
      const pub = child.publicKey;
      if (priv === null || pub === null) {
        throw new KernelError("integrity", "no private key at account path");
      }
      const signer = tronAddressFromPublicKey(pub);
      return tronBody(request, priv, signer, intentOnly);
    } finally {
      child.wipePrivateData();
    }
  } finally {
    master.wipePrivateData();
  }
};

const tronBody = (
  request: TronRequest,
  priv: Uint8Array,
  signer: string,
  intentOnly: boolean,
): ExecuteResult => {
  let normalized;
  try {
    normalized = normalizeTron(request);
  } catch (error) {
    mapChainError(error);
  }
  if (!deepEqual(normalized, request)) {
    throw new KernelError("invalid-input", "request is not normalized");
  }
  let intent: DisplayIntent;
  try {
    intent = decodeTron(request, signer);
  } catch (error) {
    mapChainError(error);
  }
  if (intentOnly) {
    return { prompt: intent };
  }
  if (request.kind === "tron.transaction") {
    return {
      kind: "tron.transaction",
      signature: signTronTransaction(request.rawData, priv),
    };
  }
  return {
    kind: "tron.message",
    signature: signTronMessage(request.message, priv),
  };
};
