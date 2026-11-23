/**
 * /tron/sign — the only file holding private-key code for the family: the local task signer, plus
 * the raw-key API reimplemented as `plan → signTronTask → assembleTron`. Inputs must already be
 * normalized: the kernel calls `normalizeTron` first and rejects on a ChainError. No key caching;
 * the caller wipes key bytes.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { ChainError } from "../index.ts";
import type { SignTask, TaskKey } from "../index.ts";
import { signLocally } from "../tasks.ts";
import { assembleTron } from "./assemble.ts";
import { planTronMessage, planTronTransaction, planTronTypedData } from "./plan.ts";

const checkKey = (privateKey: Uint8Array): void => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
};

/** Signs one task with a raw secp256k1 key: RFC 6979, low-s, compact 64 bytes. */
export const signTronTask = (task: SignTask, privateKey: Uint8Array): Uint8Array => {
  checkKey(privateKey);
  if (task.scheme !== "ecdsa-secp256k1") {
    throw new ChainError("unsupported", `tron cannot sign ${task.scheme} tasks`);
  }
  return secp256k1.sign(task.digest, privateKey, { prehash: false });
};

const key = (privateKey: Uint8Array): TaskKey => {
  checkKey(privateKey);
  return { path: [], publicKey: secp256k1.getPublicKey(privateKey, true) };
};

/** Signs raw_data; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signTronTransaction = (rawData: Uint8Array, privateKey: Uint8Array): Uint8Array =>
  signLocally(
    planTronTransaction(rawData, key(privateKey)),
    (task) => signTronTask(task, privateKey),
    assembleTron,
  );

/** TIP-191 message signing; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signTronMessage = (message: Uint8Array, privateKey: Uint8Array): Uint8Array =>
  signLocally(
    planTronMessage(message, key(privateKey)),
    (task) => signTronTask(task, privateKey),
    assembleTron,
  );

/** TIP-712 typed-data signing; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signTronTypedData = (typedData: string, privateKey: Uint8Array): Uint8Array =>
  signLocally(
    planTronTypedData(typedData, key(privateKey)),
    (task) => signTronTask(task, privateKey),
    assembleTron,
  );
