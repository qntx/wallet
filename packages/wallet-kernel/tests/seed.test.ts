/**
 * withSeed/withWalletSeed own the entropy→seed window: the seed is wiped on every path, and the
 * entropy is wiped even when derivation or `use` throws — the failure modes that previously left
 * live secret bytes behind.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type * as seedModule from "../src/seed/seed.ts";

import type { KernelPlatform } from "../src/platform.ts";
import { Secret } from "../src/secret/secret.ts";

const captured = vi.hoisted(() => ({
  entropy: undefined as Uint8Array | undefined,
  throwOnCall: false,
}));

vi.mock("../src/seed/seed.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof seedModule>();
  return {
    ...mod,
    // Passthrough that records the entropy buffer withWalletSeed opened, so the test can
    // assert the wipe landed on the very buffer openRecord returned.
    withSeed: (
      pbkdf2: KernelPlatform["pbkdf2"],
      entropy: Uint8Array,
      use: (seed: Uint8Array) => unknown,
    ) => {
      captured.entropy = entropy;
      if (captured.throwOnCall) {
        return Promise.reject(new Error("pbkdf2 blew up"));
      }
      return mod.withSeed(pbkdf2, entropy, use);
    },
  };
});

const { withSeed } = await import("../src/seed/seed.ts");
const { sealRecord, withWalletSeed } = await import("../src/vault/vault.ts");

const platform = {
  random: (n: number) => new Uint8Array(n).fill(9),
} as unknown as KernelPlatform;

const pbkdf2: KernelPlatform["pbkdf2"] = () =>
  Promise.resolve(new Uint8Array(64).fill(7));
const throwingPbkdf2: KernelPlatform["pbkdf2"] = async () => {
  throw new Error("pbkdf2 blew up");
};

const dek = Secret.take(new Uint8Array(32).fill(1));
const entropy = (): Uint8Array => new Uint8Array(32).fill(3);
const record = () => sealRecord(platform, dek, "entropy", "w1", "{}", entropy());

const zeroed = (bytes: Uint8Array | undefined): boolean =>
  bytes !== undefined && bytes.every((b) => b === 0);

describe("withSeed", () => {
  it("wipes the seed when `use` throws", async () => {
    let seen: Uint8Array | undefined;
    await expect(
      withSeed(pbkdf2, entropy(), (seed: Uint8Array) => {
        seen = seed;
        throw new Error("use failed");
      }),
    ).rejects.toThrow("use failed");
    expect(zeroed(seen)).toBe(true);
  });

  it("returns the use result and wipes the seed afterwards", async () => {
    let seen: Uint8Array | undefined;
    const out = await withSeed(pbkdf2, entropy(), (seed: Uint8Array) => {
      seen = seed;
      return seed.length;
    });
    expect(out).toBe(64);
    expect(zeroed(seen)).toBe(true);
  });

  it("does not own the entropy when derivation throws", async () => {
    const bytes = entropy();
    await expect(
      withSeed(throwingPbkdf2, bytes, (seed: Uint8Array) => seed.length),
    ).rejects.toThrow("pbkdf2 blew up");
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });
});

describe("withWalletSeed", () => {
  it("wipes the entropy when seed derivation throws", async () => {
    captured.throwOnCall = true;
    captured.entropy = undefined;
    await expect(
      withWalletSeed(pbkdf2, dek, record(), (seed: Uint8Array) => seed.length),
    ).rejects.toThrow("pbkdf2 blew up");
    captured.throwOnCall = false;
    expect(zeroed(captured.entropy)).toBe(true);
  });

  it("wipes entropy and seed when `use` throws", async () => {
    captured.entropy = undefined;
    let seen: Uint8Array | undefined;
    await expect(
      withWalletSeed(pbkdf2, dek, record(), (seed: Uint8Array) => {
        seen = seed;
        throw new Error("use failed");
      }),
    ).rejects.toThrow("use failed");
    expect(zeroed(captured.entropy)).toBe(true);
    expect(zeroed(seen)).toBe(true);
  });

  it("opens the record and returns the use result", async () => {
    const out = await withWalletSeed(pbkdf2, dek, record(), (seed: Uint8Array) => seed.length);
    expect(out).toBe(64);
  });
});
