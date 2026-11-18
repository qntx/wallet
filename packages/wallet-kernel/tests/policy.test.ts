/**
 * Vault policy consent: a `policy/<id>` record counts only when it opens under the live DEK — a row
 * sealed by anything else is an integrity failure, never silent consent.
 */
import { describe, expect, it } from "vite-plus/test";

import { nobleBackend } from "@qntx/nostr";

import type { KernelPlatform } from "../src/platform.ts";
import { Secret } from "../src/secret/secret.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import { BLIND_SIGNING, policyEnabled, sealPolicy } from "../src/vault/policy.ts";
import type { StoredRecord, VaultImage } from "../src/vault/store.ts";
import { seededRandom } from "./harness.ts";
import { kernelError, quickArgon2id, subtlePbkdf2 } from "./helpers.ts";

const platform: KernelPlatform = {
  random: seededRandom(11).random,
  now: () => 0,
  elapsed: () => 0,
  setTimer: () => () => undefined,
  pbkdf2: subtlePbkdf2,
  argon2id: quickArgon2id,
  store: createMemoryStore(),
  policy: { maxSessionMs: 0, maxScryptLogN: 20 },
  keystore: undefined,
  passkey: undefined,
  backends: {
    spark: async () => {
      await Promise.resolve();
      throw new Error("no spark backend in this test");
    },
    nostr: nobleBackend,
  },
};

const image = (records: ReadonlyArray<StoredRecord>): VaultImage => ({
  meta: undefined,
  records,
  factors: [],
});

const dek = Secret.take(new Uint8Array(32).fill(1));

/** A copy with the last byte flipped: the seal's tag no longer authenticates the payload. */
const tamperedLastByte = (bytes: Uint8Array): Uint8Array => {
  const copy = new Uint8Array(bytes);
  copy[copy.length - 1] = (copy.at(-1) ?? 0) ^ 0xff;
  return copy;
};

describe("policyEnabled", () => {
  it("is off when the vault holds no policy row", () => {
    expect(policyEnabled(image([]), dek, BLIND_SIGNING)).toBe(false);
  });

  it("is on for a genuine sealed policy record", () => {
    const record = sealPolicy(platform, dek, BLIND_SIGNING);
    expect(policyEnabled(image([record]), dek, BLIND_SIGNING)).toBe(true);
  });

  it("throws integrity for a row sealed under a different key", () => {
    const forged = sealPolicy(platform, Secret.take(new Uint8Array(32).fill(2)), BLIND_SIGNING);
    expect(kernelError(() => policyEnabled(image([forged]), dek, BLIND_SIGNING))).toBe("integrity");
  });

  it("throws integrity when a sealed byte is tampered with", () => {
    const record = sealPolicy(platform, dek, BLIND_SIGNING);
    const sealed = tamperedLastByte(record.sealed);
    expect(
      kernelError(() => policyEnabled(image([{ ...record, sealed }]), dek, BLIND_SIGNING)),
    ).toBe("integrity");
  });
});
