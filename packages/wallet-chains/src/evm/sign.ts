/**
 * /evm/sign — the only file holding private-key code for the family: the local task signer, plus
 * the raw-key API reimplemented as `plan → signEvmTask → assembleEvm`. Inputs must already be
 * normalized: the kernel calls `normalizeEvm` first and rejects on a ChainError. No key caching;
 * the caller wipes key bytes.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { ChainError } from "../index.ts";
import type { EvmTransaction, SignTask, TaskKey } from "../index.ts";
import { signLocally } from "../tasks.ts";
import { assembleEvm } from "./assemble.ts";
import { planEvmPersonalMessage, planEvmTransaction, planEvmTypedData } from "./plan.ts";

const checkKey = (privateKey: Uint8Array): void => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
};

/** Signs one task with a raw secp256k1 key: RFC 6979, low-s, compact 64 bytes. */
export const signEvmTask = (task: SignTask, privateKey: Uint8Array): Uint8Array => {
  checkKey(privateKey);
  if (task.scheme !== "ecdsa-secp256k1") {
    throw new ChainError("unsupported", `evm cannot sign ${task.scheme} tasks`);
  }
  return secp256k1.sign(task.digest, privateKey, { prehash: false });
};

const key = (privateKey: Uint8Array): TaskKey => {
  checkKey(privateKey);
  return { path: [], publicKey: secp256k1.getPublicKey(privateKey, true) };
};

/** Signs a normalized transaction; returns the serialized signed envelope. */
export const signEvmTransaction = (tx: EvmTransaction, privateKey: Uint8Array): Uint8Array =>
  signLocally(
    planEvmTransaction(tx, key(privateKey)),
    (task) => signEvmTask(task, privateKey),
    assembleEvm,
  );

/** EIP-191 personal_sign; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signEvmPersonalMessage = (message: Uint8Array, privateKey: Uint8Array): Uint8Array =>
  signLocally(
    planEvmPersonalMessage(message, key(privateKey)),
    (task) => signEvmTask(task, privateKey),
    assembleEvm,
  );

/** EIP-712 typed data; returns the 65-byte signature r‖s‖v with v∈{27,28}. */
export const signEvmTypedData = (typedData: string, privateKey: Uint8Array): Uint8Array =>
  signLocally(
    planEvmTypedData(typedData, key(privateKey)),
    (task) => signEvmTask(task, privateKey),
    assembleEvm,
  );
