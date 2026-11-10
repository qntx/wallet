/** EVM signing for `chain.sign` — derive, normalize, decode, then sign or return the intent. */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";

import type { DisplayIntent } from "@qntx/wallet-chains";
import { decodeEvm, evmAddressFromPublicKey, normalizeEvm } from "@qntx/wallet-chains/evm";
import {
  signEvmPersonalMessage,
  signEvmTransaction,
  signEvmTypedData,
} from "@qntx/wallet-chains/evm/sign";

import { KernelError } from "../../errors.ts";
import type { EvmKeySource, EvmRequest, ExecuteResult } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

export const executeEvm = (
  request: EvmRequest,
  source: EvmKeySource,
  intentOnly: boolean,
): ExecuteResult => {
  if (source.kind === "imported") {
    /* The record's plaintext is the private key; `chainSign` wipes the opened copy. */
    const priv = source.secret;
    const signer = evmAddressFromPublicKey(secp256k1.getPublicKey(priv, true));
    return evmBody(request, priv, signer, intentOnly);
  }
  const master = HDKey.fromMasterSeed(source.seed);
  try {
    const child = master.derive(`m/44'/60'/0'/0/${source.account.groupIndex}`);
    try {
      const priv = child.privateKey;
      const pub = child.publicKey;
      if (priv === null || pub === null) {
        throw new KernelError("integrity", "no private key at account path");
      }
      const signer = evmAddressFromPublicKey(pub);
      return evmBody(request, priv, signer, intentOnly);
    } finally {
      child.wipePrivateData();
    }
  } finally {
    master.wipePrivateData();
  }
};

const evmBody = (
  request: EvmRequest,
  priv: Uint8Array,
  signer: string,
  intentOnly: boolean,
): ExecuteResult => {
  let normalized;
  try {
    normalized = normalizeEvm(request);
  } catch (error) {
    mapChainError(error);
  }
  if (!deepEqual(normalized, request)) {
    throw new KernelError("invalid-input", "request is not normalized");
  }
  let intent: DisplayIntent;
  try {
    intent = decodeEvm(request, signer);
  } catch (error) {
    mapChainError(error);
  }
  if (intentOnly) {
    return { prompt: intent };
  }
  if (request.kind === "evm.transaction") {
    return {
      kind: "evm.transaction",
      signedTransaction: signEvmTransaction(request.tx, priv),
    };
  }
  if (request.kind === "evm.personal-message") {
    return {
      kind: "evm.personal-message",
      signature: signEvmPersonalMessage(request.message, priv),
    };
  }
  return {
    kind: "evm.typed-data",
    signature: signEvmTypedData(request.typedData, priv),
  };
};
