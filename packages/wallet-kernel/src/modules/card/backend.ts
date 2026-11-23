/**
 * The card signing backend (design §8, protocol §9.9–§9.11): turns one prepared `ChainTask` into
 * the card commands that produce its signature. The card never sees a request or a plan — only
 * digests, paths and the Ed25519 challenge stream — and every response is re-verified against the
 * task's public key by `decode`, so a hostile or faulty card cannot slip a bad signature through.
 */
import { equalBytes } from "@noble/ciphers/utils.js";

import type { SignTask } from "@qntx/wallet-chains";

import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import { priceOf } from "./budget.ts";
import { cmd } from "./protocol/commands.ts";
import { decode } from "./protocol/decode.ts";
import { bip340OutputX } from "./protocol/signatures.ts";
import type { TapSession } from "./tap.ts";

/**
 * Estimated card ms of one task's commands — the price of its APDUs, matching the wire the backend
 * sends: a single command for ecdsa/bip340, begin + ceil((64+|M|)/236) chunks for ed25519 (the
 * stream `encode(R)‖encode(A)‖M` of §12.3).
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const taskPrice = (task: SignTask): number => {
  switch (task.scheme) {
    case "ecdsa-secp256k1":
      return priceOf("sign-ecdsa");
    case "bip340":
      return priceOf("sign-bip340");
    case "ed25519": {
      // update and finish cost the same; the last chunk is always a finish.
      const chunks = Math.ceil((64 + task.message.length) / 236);
      return priceOf("ed25519-begin") + chunks * priceOf("ed25519-finish");
    }
  }
};

/**
 * SIGN_ECDSA — `digest(32) ‖ path` → `r‖s`, verified against `task.digest`/`task.publicKey` by
 * decode (§12.1); a repeated `r` — the nonce-reuse signature — is `card-fault` at decode. Returns
 * the signature and its `r` so the op can feed it to the next task.
 */
export const signEcdsaTask = async (
  tap: TapSession,
  task: Extract<SignTask, { scheme: "ecdsa-secp256k1" }>,
  previousR: ReadonlyArray<Uint8Array>,
): Promise<{ readonly signature: Uint8Array; readonly r: Uint8Array }> => {
  const { signature } = decode.ecdsa(
    await tap.send(cmd.signEcdsa(task.digest, task.path)),
    task.digest,
    task.publicKey,
    previousR,
  );
  return { signature, r: signature.subarray(0, 32) };
};

/**
 * SIGN_BIP340 — `message(32) ‖ tweak(32) ‖ path` → `R_x‖s`; decode verifies it against the tweaked
 * internal key `P` and the tweaked output key is checked to be the task's (§12.2).
 */
export const signBip340Task = async (
  tap: TapSession,
  task: Extract<SignTask, { scheme: "bip340" }>,
  internalKey: Uint8Array,
): Promise<Uint8Array> => {
  if (!equalBytes(bip340OutputX(internalKey, task.tweak), task.publicKey)) {
    throw new KernelError("card-fault", "the card's tweaked key is not the task's output key");
  }
  return decode.bip340(
    await tap.send(cmd.signBip340(task.message, task.tweak, task.path)),
    task.message,
    internalKey,
    task.tweak,
  );
};

/**
 * SIGN_ED25519 — begin(path) → `W(R)`, then the challenge stream `encode(R)‖encode(A)‖M` in
 * ≤236-byte update chunks and one finish carrying `le32(S)`; decode assembles and verifies the RFC
 * 8032 signature (§12.3). `publicKey` is the task's RFC 8032 key.
 */
export const signEd25519Task = async (
  tap: TapSession,
  task: Extract<SignTask, { scheme: "ed25519" }>,
  publicKey: Uint8Array,
): Promise<Uint8Array> => {
  const encodedR = decode.weiPoint(await tap.send(cmd.ed25519Begin(task.path)));
  const chunks = cmd.ed25519Stream(encodedR, publicKey, task.message);
  let data: Uint8Array = new Uint8Array(0);
  for (const chunk of chunks) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the card's stream is strictly sequential
    data = await tap.send(chunk);
  }
  return decode.ed25519(data, encodedR, publicKey, task.message);
};

/**
 * Sign one prepared task on the open card session. BIP-340 derives the internal key `P` at
 * `task.path` from card material (a miss → `device-required`), ed25519 insists the cached key is
 * exactly `task.publicKey` (`integrity` otherwise — the prepare already bound it), ecdsa tracks `r`
 * across the op so a reused nonce is `card-fault`.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const signTask = async (
  tap: TapSession,
  task: SignTask,
  material: PublicMaterial,
  previousR: Uint8Array[],
): Promise<Uint8Array> => {
  switch (task.scheme) {
    case "ecdsa-secp256k1": {
      const { signature, r } = await signEcdsaTask(tap, task, previousR);
      previousR.push(r);
      return signature;
    }
    case "bip340":
      return signBip340Task(tap, task, await material.secp256k1(task.path));
    case "ed25519": {
      const publicKey = await material.ed25519(task.path);
      if (!equalBytes(publicKey, task.publicKey)) {
        throw new KernelError("integrity", "the card's ed25519 key is not the task's key");
      }
      return signEd25519Task(tap, task, publicKey);
    }
  }
};
