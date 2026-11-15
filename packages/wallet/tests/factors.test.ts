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
    const transfer: ArrayBuffer[] = [];
    await expect(resolveFactor(hardware, { kind: "device" }, transfer)).resolves.toStrictEqual({
      kind: "device",
    });
    await expect(resolveFactor(hardware, { kind: "hardware" }, transfer)).resolves.toStrictEqual({
      kind: "hardware",
    });
    expect(transfer).toStrictEqual([]);
  });

  it("lets the host choose its own factors, wiping a vault PRF", async () => {
    await expect(resolveInitialFactor(hardware, undefined, [])).resolves.toStrictEqual({
      kind: "device",
    });
    const second = new Uint8Array(32).fill(7);
    await expect(
      resolveInitialFactor(hardware, undefined, [], {
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
          [],
        ),
      ),
    ).resolves.toBe("unsupported");
  });

  it("refuses software factors before any ceremony", async () => {
    await expect(code(resolveFactor(hardware, { kind: "passkey" }, []))).resolves.toBe(
      "unsupported",
    );
    await expect(
      code(resolveFactor(hardware, { kind: "password", password: "long enough pw" }, [])),
    ).resolves.toBe("unsupported");
    await expect(
      code(resolveInitialFactor(hardware, { kind: "passkey", name: "me" }, [])),
    ).resolves.toBe("unsupported");
  });

  it("rejects a device verifier before any ceremony", async () => {
    await expect(
      code(resolveVerifyFactor(hardware, { kind: "device" } as never, [])),
    ).resolves.toBe("invalid-input");
    const transfer: ArrayBuffer[] = [];
    await expect(
      resolveVerifyFactor(hardware, { kind: "hardware" }, transfer),
    ).resolves.toStrictEqual({ kind: "hardware" });
    expect(transfer).toStrictEqual([]);
  });
});

describe("software host", () => {
  const software = source("software");

  it("defaults unlock to passkey and refuses hardware", async () => {
    expect(defaultUnlockFactor(software)).toStrictEqual({ kind: "passkey" });
    await expect(code(resolveFactor(software, { kind: "hardware" }, []))).resolves.toBe(
      "unsupported",
    );
    await expect(code(resolveFactor(software, { kind: "device" }, []))).resolves.toBe(
      "unsupported",
    );
    await expect(
      code(resolveInitialFactor(software, { kind: "hardware" } as never, [])),
    ).resolves.toBe("unsupported");
  });

  it("resolves a password factor to UTF-8 bytes on the transfer list", async () => {
    const transfer: ArrayBuffer[] = [];
    const wire = await resolveFactor(
      software,
      { kind: "password", password: "pässword!" },
      transfer,
    );
    expect(wire.kind).toBe("password");
    expect(transfer).toHaveLength(1);
  });
});

it("backup factors are never hardware", async () => {
  await expect(
    code(resolveBackupFactor(source("hardware"), { kind: "hardware" }, [])),
  ).resolves.toBe("invalid-input");
});
