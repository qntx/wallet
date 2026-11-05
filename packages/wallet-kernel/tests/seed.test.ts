/**
 * WithSeed/withWalletSeed own the entropy→seed window: the seed is wiped on every path, and the
 * entropy is wiped even when derivation or `use` throws — the failure modes that previously left
 * live secret bytes behind.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { KernelPlatform } from "../src/platform.ts";
import { Secret } from "../src/secret/secret.ts";
import type * as seedModule from "../src/seed/seed.ts";

const captured = vi.hoisted(() => ({
  entropy: undefined as Uint8Array | undefined,
  passphrase: undefined as string | undefined,
  throwOnCall: false,
}));

vi.mock("../src/seed/seed.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof seedModule>();
  return {
    ...mod,
    // Passthrough that records the entropy buffer withWalletSeed opened, so the test can
    // assert the wipe landed on the very buffer openRecord returned.
    withSeed: async (
      pbkdf2: KernelPlatform["pbkdf2"],
      entropy: Uint8Array,
      passphrase: string,
      use: (seed: Uint8Array) => unknown,
    ) => {
      captured.entropy = entropy;
      captured.passphrase = passphrase;
      if (captured.throwOnCall) {
        return Promise.reject(new Error("pbkdf2 blew up"));
      }
      return mod.withSeed(pbkdf2, entropy, passphrase, use);
    },
  };
});

const { withSeed } = await import("../src/seed/seed.ts");
const { sealRecord } = await import("../src/vault/vault.ts");
const { withWalletSeed } = await import("../src/commands/vault.ts");
const { encodeHeader } = await import("../src/vault/headers.ts");

const platform = {
  random: (n: number) => new Uint8Array(n).fill(9),
} as unknown as KernelPlatform;

const pbkdf2: KernelPlatform["pbkdf2"] = async () => Promise.resolve(new Uint8Array(64).fill(7));
const throwingPbkdf2: KernelPlatform["pbkdf2"] = async () =>
  Promise.reject(new Error("pbkdf2 blew up"));

const dek = Secret.take(new Uint8Array(32).fill(1));
const entropy = (): Uint8Array => new Uint8Array(32).fill(3);
const header = (passphrase?: true): string =>
  encodeHeader({
    walletId: "0000000000000001",
    origin: "mnemonic",
    words: 24,
    ...(passphrase === undefined ? {} : { passphrase }),
    backup: "none",
    createdAt: 0,
  });
const record = () => sealRecord(platform, dek, "entropy", "0000000000000001", header(), entropy());
const passphraseRecord = (passphraseBytes: Uint8Array) =>
  sealRecord(
    platform,
    dek,
    "entropy",
    "0000000000000001",
    header(true),
    new Uint8Array([...entropy(), ...passphraseBytes]),
  );

const zeroed = (bytes: Uint8Array | undefined): boolean =>
  bytes !== undefined && bytes.every((b) => b === 0);

describe("withSeed", () => {
  it("wipes the seed when `use` throws", async () => {
    let seen: Uint8Array | undefined;
    await expect(
      withSeed(pbkdf2, entropy(), "", (seed: Uint8Array) => {
        seen = seed;
        throw new Error("use failed");
      }),
    ).rejects.toThrow("use failed");
    expect(zeroed(seen)).toBe(true);
  });

  it("returns the use result and wipes the seed afterwards", async () => {
    let seen: Uint8Array | undefined;
    const out = await withSeed(pbkdf2, entropy(), "", (seed: Uint8Array) => {
      seen = seed;
      return seed.length;
    });
    expect(out).toBe(64);
    expect(zeroed(seen)).toBe(true);
  });

  it("does not own the entropy when derivation throws", async () => {
    const bytes = entropy();
    await expect(
      withSeed(throwingPbkdf2, bytes, "", (seed: Uint8Array) => seed.length),
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
    expect(captured.passphrase).toBe("");
  });

  it("derives from the record's passphrase", async () => {
    await withWalletSeed(
      pbkdf2,
      dek,
      passphraseRecord(new TextEncoder().encode("pässword")),
      (seed: Uint8Array) => seed.length,
    );
    expect(captured.passphrase).toBe("pässword");
  });
});
