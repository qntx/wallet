import { readFileSync } from "node:fs";
import { join } from "node:path";

import { argon2id } from "@noble/hashes/argon2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { KernelError } from "../src/errors.ts";
import type { KernelErrorCode } from "../src/errors.ts";
import type { Argon2id, Pbkdf2, Random } from "../src/platform.ts";

const VECTORS = join(import.meta.dirname, "../../../vectors");

export function loadVectors(file: string): unknown {
  return JSON.parse(readFileSync(join(VECTORS, file), "utf8"));
}

/** Test-only PBKDF2 over WebCrypto (global in Node ≥ 20 and browsers). */
export const subtlePbkdf2: Pbkdf2 = async (hash, password, salt, iterations, length) => {
  const algorithm = hash === "sha256" ? "SHA-256" : "SHA-512";
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new Uint8Array(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: algorithm, salt: new Uint8Array(salt), iterations },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
};

/** Deterministic Random for vector tests: returns `bytes` (no length check). */
export function fixedRandom(bytes: Uint8Array): Random {
  return () => bytes;
}

/** Runs `fn` and returns the KernelError code it threw, if it did. */
export function kernelError(fn: () => unknown): KernelErrorCode | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof KernelError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

/**
 * The platform's Argon2id for tests that are not about its output: the same function at a token
 * cost, so a suite does not spend seconds per backup password. It still fails on any cost but the
 * one the kernel is specified to ask for. The vector test runs the real cost.
 */
// oxlint-disable-next-line typescript/require-await -- an Argon2id is asynchronous by contract
export const quickArgon2id: Argon2id = async (password, salt, cost, length) => {
  if (cost.memoryKiB !== 65_536 || cost.passes !== 3 || cost.lanes !== 4) {
    throw new Error(`unexpected argon2id cost ${JSON.stringify(cost)}`);
  }
  return argon2id(password, salt, { m: 32, t: 1, p: 4, dkLen: length });
};

// oxlint-disable-next-line typescript/require-await -- an Argon2id is asynchronous by contract
export const realArgon2id: Argon2id = async (password, salt, cost, length) =>
  argon2id(password, salt, { m: cost.memoryKiB, t: cost.passes, p: cost.lanes, dkLen: length });

/**
 * The backup payload AEAD context for an envelope's header and factor list — the canonical factor
 * serialization the kernel authenticates, for tests that re-seal or open a payload.
 */
export function backupPayloadContext(
  header: string,
  factors: ReadonlyArray<Record<string, unknown>>,
): string {
  const canonical = JSON.stringify(
    factors.map((f) =>
      f["kind"] === "passkey"
        ? { kind: f["kind"], credentialId: f["credentialId"], sealedBek: f["sealedBek"] }
        : {
            kind: f["kind"],
            kdf: f["kdf"],
            memoryKiB: f["memoryKiB"],
            passes: f["passes"],
            lanes: f["lanes"],
            salt: f["salt"],
            sealedBek: f["sealedBek"],
          },
    ),
  );
  return `qntx-wallet/backup/v1/payload/${bytesToHex(sha256(utf8ToBytes(header)))}/${bytesToHex(sha256(utf8ToBytes(canonical)))}`;
}
