/**
 * Factor resolution per host mode: a hardware host (React Native) resolves the material-free
 * device/hardware factors and refuses software factors before any ceremony; a software host
 * (web/node) refuses keystore factors. Device can never verify — resolveVerifyFactor is the
 * fail-closed gate on every verify parameter.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  defaultUnlockFactor,
  resolveBackupFactor,
  resolveFactor,
  resolveInitialFactor,
  resolveVerifyFactor,
  SecretWire,
} from "../src/factors.ts";
import type { FactorMode, FactorSource, PasskeyCeremony } from "../src/factors.ts";
import { WalletError } from "../src/types.ts";

const PASSKEY = {
  rpId: "example.com",
  rpName: "Example",
  walletSalt: "example/wallet/v1",
  vaultSalt: "example/vault/v1",
  backupSalt: "example/backup/v1",
};

const failingCeremony: PasskeyCeremony = {
  create: async () => {
    await Promise.resolve();
    throw new Error("no ceremony expected");
  },
  assert: async () => {
    await Promise.resolve();
    throw new Error("no ceremony expected");
  },
};

const source = (mode: FactorMode, appLock = false): FactorSource => ({
  mode,
  passkey: PASSKEY,
  ceremony: failingCeremony,
  factors: () => [],
  appLock: () => appLock,
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WalletError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a WalletError");
}

describe("hardware host", () => {
  const hardware = source("hardware");

  it("defaults unlock to the device factor, or hardware while the app lock is on", () => {
    expect(defaultUnlockFactor(hardware)).toStrictEqual({ kind: "device" });
    expect(defaultUnlockFactor(source("hardware", true))).toStrictEqual({ kind: "hardware" });
  });

  it("resolves device and hardware unlock factors without material", async () => {
    const wire = new SecretWire();
    await expect(resolveFactor(hardware, { kind: "device" }, wire)).resolves.toStrictEqual({
      kind: "device",
    });
    await expect(resolveFactor(hardware, { kind: "hardware" }, wire)).resolves.toStrictEqual({
      kind: "hardware",
    });
    expect(wire.transfer).toStrictEqual([]);
  });

  it("lets the host choose its own factors, wiping a vault PRF", async () => {
    await expect(
      resolveInitialFactor(hardware, undefined, new SecretWire()),
    ).resolves.toStrictEqual({
      kind: "device",
    });
    const second = new Uint8Array(32).fill(7);
    await expect(
      resolveInitialFactor(hardware, undefined, new SecretWire(), {
        credentialId: new Uint8Array([1]),
        first: new Uint8Array(32),
        second,
        synced: true,
      }),
    ).resolves.toStrictEqual({ kind: "device" });
    expect(second.every((byte) => byte === 0)).toBe(true);
    await expect(
      code(
        resolveInitialFactor(
          hardware,
          { kind: "password", password: "long enough pw" } as never,
          new SecretWire(),
        ),
      ),
    ).resolves.toBe("unsupported");
  });

  it("refuses software factors before any ceremony", async () => {
    await expect(
      code(resolveFactor(hardware, { kind: "passkey" }, new SecretWire())),
    ).resolves.toBe("unsupported");
    await expect(
      code(
        resolveFactor(hardware, { kind: "password", password: "long enough pw" }, new SecretWire()),
      ),
    ).resolves.toBe("unsupported");
    await expect(
      code(resolveInitialFactor(hardware, { kind: "passkey", name: "me" }, new SecretWire())),
    ).resolves.toBe("unsupported");
  });

  it("rejects a device verifier before any ceremony", async () => {
    await expect(
      code(resolveVerifyFactor(hardware, { kind: "device" } as never, new SecretWire())),
    ).resolves.toBe("invalid-input");
    const wire = new SecretWire();
    await expect(resolveVerifyFactor(hardware, { kind: "hardware" }, wire)).resolves.toStrictEqual({
      kind: "hardware",
    });
    expect(wire.transfer).toStrictEqual([]);
  });
});

describe("software host", () => {
  const software = source("software");

  it("defaults unlock to passkey and refuses hardware", async () => {
    expect(defaultUnlockFactor(software)).toStrictEqual({ kind: "passkey" });
    await expect(
      code(resolveFactor(software, { kind: "hardware" }, new SecretWire())),
    ).resolves.toBe("unsupported");
    await expect(code(resolveFactor(software, { kind: "device" }, new SecretWire()))).resolves.toBe(
      "unsupported",
    );
    await expect(
      code(resolveInitialFactor(software, { kind: "hardware" } as never, new SecretWire())),
    ).resolves.toBe("unsupported");
  });

  it("resolves a password factor to UTF-8 bytes on the transfer list", async () => {
    const wire = new SecretWire();
    const factor = await resolveFactor(software, { kind: "password", password: "pässword!" }, wire);
    expect(factor.kind).toBe("password");
    expect(wire.transfer).toHaveLength(1);
  });
});

describe("the backup password factor", () => {
  it("refuses a password string on a hardware host before any ceremony", async () => {
    await expect(
      code(
        resolveBackupFactor(
          source("hardware"),
          { kind: "password", password: "a backup password" },
          new SecretWire(),
        ),
      ),
    ).resolves.toBe("unsupported");
  });

  it("resolves an absent password to the kernel ceremony arm on a hardware host", async () => {
    const factor = await resolveBackupFactor(
      source("hardware"),
      { kind: "password" },
      new SecretWire(),
    );
    expect(factor).toStrictEqual({ kind: "password", ceremony: "kernel" });
  });

  it("requires the password string on a software host", async () => {
    await expect(
      code(resolveBackupFactor(source("software"), { kind: "password" }, new SecretWire())),
    ).resolves.toBe("invalid-input");
  });

  it("resolves a password string to UTF-8 bytes on a software host", async () => {
    const wire = new SecretWire();
    const factor = await resolveBackupFactor(
      source("software"),
      { kind: "password", password: "a backup password" },
      wire,
    );
    expect(factor.kind).toBe("password");
    expect(wire.transfer).toHaveLength(1);
  });
});
