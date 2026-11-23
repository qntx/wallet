/** TRON request preparation for `chain.sign` — normalize, decode, and plan; never signs. */
import type { DisplayIntent, KeyPath } from "@qntx/wallet-chains";
import {
  decodeTron,
  normalizeTron,
  planTron,
  tronAddressFromPublicKey,
} from "@qntx/wallet-chains/tron";

import { KernelError } from "../../errors.ts";
import type { PublicMaterial } from "./keys.ts";
import type { Prepared, TronRequest } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

/**
 * Validates and decodes the request and returns its signing plan. `path` is the account's BIP-32
 * path (`[]` for an imported key); the public key comes only through `material`.
 */
export const prepareTron = async (
  request: TronRequest,
  path: KeyPath,
  material: PublicMaterial,
): Promise<Prepared> => {
  const pub = await material.secp256k1(path);
  const signer = tronAddressFromPublicKey(pub);
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
  let plan;
  try {
    plan = planTron(request, { path, publicKey: pub });
  } catch (error) {
    mapChainError(error);
  }
  return { prompt: intent, plan };
};
