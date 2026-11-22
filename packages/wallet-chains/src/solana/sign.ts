/**
 * /solana/sign — the only file holding private-key code for the family: the local task signer,
 * plus the raw-key API reimplemented as `plan → signSolanaTask → assembleSolana`. Inputs must
 * already be normalized: the kernel calls `normalizeSolana` first. No key caching; the caller
 * wipes key bytes.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

import { ChainError } from "../index.ts";
import type { SignTask, TaskKey } from "../index.ts";
import { signLocally } from "../tasks.ts";
import { assembleSolana } from "./assemble.ts";
import { planSolanaMessage } from "./plan.ts";

const checkKey = (privateKey: Uint8Array): void => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be a 32-byte seed");
  }
};

/** Signs one task with a raw Ed25519 seed: deterministic, 64 bytes. */
export const signSolanaTask = (task: SignTask, privateKey: Uint8Array): Uint8Array => {
  checkKey(privateKey);
  if (task.scheme !== "ed25519") {
    throw new ChainError("unsupported", `solana cannot sign ${task.scheme} tasks`);
  }
  return ed25519.sign(task.message, privateKey);
};

/** Signs `message` with a 32-byte Ed25519 seed; returns the 64-byte signature. */
export const signSolanaMessage = (message: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  checkKey(privateKey);
  const key: TaskKey = { path: [], publicKey: ed25519.getPublicKey(privateKey) };
  return signLocally(
    planSolanaMessage("solana.message", message, key),
    (task) => signSolanaTask(task, privateKey),
    assembleSolana,
  );
};
