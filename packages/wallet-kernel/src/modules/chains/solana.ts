/** Solana request preparation for `chain.sign` — normalize, decode, and plan; never signs. */
import type { KeyPath } from "@qntx/wallet-chains";
import { messageContent } from "@qntx/wallet-chains";
import {
  decodeSolana,
  normalizeSolana,
  planSolana,
  solanaAddressFromPublicKey,
} from "@qntx/wallet-chains/solana";

import { KernelError } from "../../errors.ts";
import type { PublicMaterial } from "./keys.ts";
import { messagePromptIntent } from "./prompt.ts";
import type { PromptIntent } from "./prompt.ts";
import type { Prepared, SolanaRequest } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

/**
 * Validates and decodes the request and returns its signing plan. `path` is the account's SLIP-10
 * path (`[]` for an imported key); the public key comes only through `material`.
 */
export const prepareSolana = async (
  request: SolanaRequest,
  path: KeyPath,
  material: PublicMaterial,
): Promise<Prepared> => {
  const pub = await material.ed25519(path);
  const signer = solanaAddressFromPublicKey(pub);
  let normalized;
  try {
    normalized = normalizeSolana(request, signer);
  } catch (error) {
    mapChainError(error);
  }
  if (!deepEqual(normalized, request)) {
    throw new KernelError("invalid-input", "request is not normalized");
  }
  let intent: PromptIntent = {
    ...messagePromptIntent(messageContent(request.message, "solana")),
    family: "solana",
  };
  if (request.kind === "solana.transaction") {
    try {
      intent = decodeSolana(request, signer);
    } catch (error) {
      mapChainError(error);
    }
  }
  let plan;
  try {
    plan = planSolana(request, { path, publicKey: pub });
  } catch (error) {
    mapChainError(error);
  }
  return { prompt: intent, plan };
};
