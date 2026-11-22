/**
 * /bitcoin/sign — the only file holding private-key code for the family: the local task signer
 * (ECDSA, and BIP-340 with the protocol.md §12.2 generic tweak, equal to btc-signer's
 * taprootTweakPrivKey when the tweak is TapTweak(x(P))), plus the raw-key API reimplemented as
 * `plan → signBitcoinTask → assemble`. Inputs must already be normalized: the kernel calls
 * `normalizeBitcoin` first. No key caching.
 */
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";

import { ChainError } from "../index.ts";
import type { SignTask, TaskKey } from "../index.ts";
import { signLocally } from "../tasks.ts";
import { assembleBitcoinMessage, assembleBitcoinPsbt } from "./assemble.ts";
import { planBitcoinMessage, planBitcoinPsbt } from "./plan.ts";

const { Fn } = secp256k1.Point;

const checkKey = (privateKey: Uint8Array): void => {
  if (privateKey.length !== 32) {
    throw new ChainError("invalid-request", "private key must be 32 bytes");
  }
};

const uint256 = (bytes: Uint8Array): bigint =>
  bytes.reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);

/** Signs one task with a raw secp256k1 key; `auxRand` feeds only the BIP-340 nonce. */
export const signBitcoinTask = (
  task: SignTask,
  privateKey: Uint8Array,
  auxRand: Uint8Array,
): Uint8Array => {
  checkKey(privateKey);
  if (task.scheme === "ecdsa-secp256k1") {
    return secp256k1.sign(task.digest, privateKey, { prehash: false });
  }
  if (task.scheme === "bip340") {
    const d0 = Fn.fromBytes(privateKey);
    const internal = secp256k1.Point.BASE.multiply(d0).toAffine().y % 2n === 0n ? d0 : Fn.neg(d0);
    const tweak = uint256(task.tweak);
    if (tweak >= Fn.ORDER) {
      throw new ChainError("invalid-request", "tweak is not a valid scalar");
    }
    const d = Fn.create(internal + tweak);
    if (d === 0n) {
      throw new ChainError("invalid-request", "tweaked key is zero");
    }
    return schnorr.sign(task.message, Fn.toBytes(d), auxRand);
  }
  throw new ChainError("unsupported", `bitcoin cannot sign ${task.scheme} tasks`);
};

export const signBitcoinPsbt = (
  psbt: Uint8Array,
  inputs: ReadonlyArray<{ index: number; privateKey: Uint8Array }>,
  auxRand: (n: number) => Uint8Array,
): Uint8Array => {
  const entries = inputs.map(({ index, privateKey }) => {
    if (privateKey.length !== 32) {
      throw new ChainError("invalid-request", `input ${index}: private key must be 32 bytes`);
    }
    return {
      index,
      privateKey,
      key: { path: [], publicKey: secp256k1.getPublicKey(privateKey, true) } satisfies TaskKey,
    };
  });
  const plan = planBitcoinPsbt(
    psbt,
    entries.map(({ index, key }) => ({ index, key })),
  );
  return signLocally(
    plan,
    (task, i) => {
      const entry = entries[i];
      if (entry === undefined) {
        throw new ChainError("invalid-request", "task has no input");
      }
      return signBitcoinTask(task, entry.privateKey, auxRand(entry.index));
    },
    assembleBitcoinPsbt,
  );
};

/** Returns the signature string: `smp…` base64 witness for bip322-simple, compact base64 for legacy. */
export const signBitcoinMessage = (
  request: {
    network: string;
    address: string;
    message: string;
    format: "bip322-simple" | "legacy";
  },
  privateKey: Uint8Array,
  auxRand: (n: number) => Uint8Array,
): string => {
  checkKey(privateKey);
  const key: TaskKey = { path: [], publicKey: secp256k1.getPublicKey(privateKey, true) };
  const plan = planBitcoinMessage(request, key);
  return signLocally(
    plan,
    (task) =>
      signBitcoinTask(
        task,
        privateKey,
        // The legacy path never drew auxRand before; keep the caller's random consumption
        // identical — a BIP-340 task is the only one that reads it.
        plan.format === "legacy" ? new Uint8Array(32) : auxRand(0),
      ),
    assembleBitcoinMessage,
  );
};
