/**
 * /tron/plan — the serialisable signing plan of a normalized request: a transaction plans
 * sha256(raw_data), a message the TIP-191 digest, typed data the TIP-712 digest. No key material.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import { ChainError } from "../index.ts";
import type { EcdsaTask, SignRequest, TaskKey } from "../index.ts";
import { tronMessageDigest } from "./message.ts";
import { decodeTronRawData } from "./raw.ts";
import { parseTronTypedData, tronTypedDataDigest } from "./typed-data.ts";

export type TronSignPlan = {
  readonly kind: "tron.transaction" | "tron.message" | "tron.typed-data";
  readonly tasks: readonly [EcdsaTask];
};

const ecdsa = (digest: Uint8Array, key: TaskKey): EcdsaTask => ({
  scheme: "ecdsa-secp256k1",
  path: key.path,
  publicKey: key.publicKey,
  digest,
});

export const planTronTransaction = (rawData: Uint8Array, key: TaskKey): TronSignPlan => {
  if (rawData.length === 32) {
    throw new ChainError("invalid-request", "a bare 32-byte digest is not a TRON transaction");
  }
  decodeTronRawData(rawData);
  return { kind: "tron.transaction", tasks: [ecdsa(sha256(rawData), key)] };
};

export const planTronMessage = (message: Uint8Array, key: TaskKey): TronSignPlan => {
  if (message.length === 0) {
    throw new ChainError("invalid-request", "a TRON message is non-empty bytes");
  }
  return { kind: "tron.message", tasks: [ecdsa(tronMessageDigest(message), key)] };
};

export const planTronTypedData = (typedData: string, key: TaskKey): TronSignPlan => ({
  kind: "tron.typed-data",
  tasks: [ecdsa(tronTypedDataDigest(parseTronTypedData(typedData).json), key)],
});

/** The plan of a normalized request; the task keeps the request kind so the kernel can wrap it. */
export const planTron = (
  request: Extract<
    SignRequest,
    { kind: "tron.transaction" | "tron.message" | "tron.typed-data" }
  >,
  key: TaskKey,
): TronSignPlan => {
  if (request.kind === "tron.transaction") {
    return planTronTransaction(request.rawData, key);
  }
  if (request.kind === "tron.typed-data") {
    return planTronTypedData(request.typedData, key);
  }
  return planTronMessage(request.message, key);
};
