/** EVM request preparation for `chain.sign` — normalize, decode, and plan; never signs. */
import type { DisplayIntent, KeyPath } from "@qntx/wallet-chains";
import { decodeEvm, evmAddressFromPublicKey, normalizeEvm, planEvm } from "@qntx/wallet-chains/evm";

import { KernelError } from "../../errors.ts";
import type { PublicMaterial } from "./keys.ts";
import type { EvmRequest, Prepared } from "./shared.ts";
import { deepEqual, mapChainError } from "./shared.ts";

/* A Fiat24 session grant signs only inside the API's documented twenty-minute maximum, and never
   past an already-past deadline. `now` is the kernel wall clock in milliseconds; `chainSign`
   checks again before the sign pass so a prompt that outlives the window is refused. */
const FIAT24_SESSION_WINDOW = 1200;

export const assertFiat24Deadline = (request: EvmRequest, now: number): void => {
  if (request.kind !== "evm.fiat24-session") {
    return;
  }
  const left = request.deadline - Math.floor(now / 1000);
  if (!(left > 0 && left <= FIAT24_SESSION_WINDOW)) {
    throw new KernelError("invalid-input", "fiat24 session deadline out of range");
  }
};

/**
 * Validates and decodes the request and returns its signing plan. `path` is the account's BIP-32
 * path (`[]` for an imported key); the public key comes only through `material`.
 */
export const prepareEvm = async (
  request: EvmRequest,
  path: KeyPath,
  material: PublicMaterial,
  now: number,
): Promise<Prepared> => {
  assertFiat24Deadline(request, now);
  const pub = await material.secp256k1(path);
  const signer = evmAddressFromPublicKey(pub);
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
  let plan;
  try {
    plan = planEvm(request, { path, publicKey: pub });
  } catch (error) {
    mapChainError(error);
  }
  return { prompt: intent, signer, plan };
};
