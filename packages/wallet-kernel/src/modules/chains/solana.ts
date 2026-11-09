/** Solana signing for `chain.sign` — the slip10 path, normalize, decode, sign or intent. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import {
  decodeSolana,
  normalizeSolana,
  solanaAddressFromPublicKey,
} from "@qntx/wallet-chains/solana";
import { signSolanaMessage } from "@qntx/wallet-chains/solana/sign";

import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import { messageIntent } from "./prompt.ts";
import type { PromptIntent } from "./prompt.ts";
import type { ExecuteResult, SolanaKeySource, SolanaRequest } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

export const executeSolana = (
  request: SolanaRequest,
  source: SolanaKeySource,
  intentOnly: boolean,
): ExecuteResult => {
  if (source.kind === "imported") {
    const priv = source.secret;
    const signer = solanaAddressFromPublicKey(ed25519.getPublicKey(priv));
    return solanaBody(request, priv, signer, intentOnly);
  }
  const root = Slip10.fromMasterSeed(source.seed);
  const child = root.derive(`m/44'/501'/${source.account.groupIndex}'/0'`);
  try {
    const priv = child.privateKey;
    const signer = solanaAddressFromPublicKey(ed25519.getPublicKey(priv));
    return solanaBody(request, priv, signer, intentOnly);
  } finally {
    wipe(child.privateKey);
    wipe(root.privateKey);
  }
};

const solanaBody = (
  request: SolanaRequest,
  priv: Uint8Array,
  signer: string,
  intentOnly: boolean,
): ExecuteResult => {
  {
    let normalized;
    try {
      normalized = normalizeSolana(request, signer);
    } catch (error) {
      mapChainError(error);
    }
    if (!deepEqual(normalized, request)) {
      throw new KernelError("invalid-input", "request is not normalized");
    }
    let intent: PromptIntent = messageIntent(request.message);
    if (request.kind === "solana.transaction") {
      try {
        intent = decodeSolana(request, signer);
      } catch (error) {
        mapChainError(error);
      }
    }
    if (intentOnly) {
      return { prompt: intent };
    }
    return {
      kind: request.kind,
      signature: signSolanaMessage(request.message, priv),
    };
  }
};
