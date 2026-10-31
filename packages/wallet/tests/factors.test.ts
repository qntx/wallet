/**
 * Factor resolution per host mode: a hardware host (React Native) resolves everything to the
 * material-free hardware factor and refuses software factors before any ceremony; a software host
 * (web/node) refuses hardware.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  defaultUnlockFactor,
  resolveBackupFactor,
  resolveFactor,
  resolveInitialFactor,
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

const source = (mode: FactorMode): FactorSource => ({
  mode,
  passkey: PASSKEY,
  ceremony: failingCeremony,
  factors: () => [],
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

  it("defaults unlock to hardware and resolves it without material", async () => {
    expect(defaultUnlockFactor(hardware)).toStrictEqual({ kind: "hardware" });
    const transfer: ArrayBuffer[] = [];
    await expect(resolveFactor(hardware, { kind: "hardware" }, transfer)).resolves.toStrictEqual({
      kind: "hardware",
    });
    expect(transfer).toStrictEqual([]);
  });

  it("establishes the hardware factor when none or hardware is given and wipes a vault PRF", async () => {
    await expect(resolveInitialFactor(hardware, undefined, [])).resolves.toStrictEqual({
      kind: "hardware",
    });
    const second = new Uint8Array(32).fill(7);
    await expect(
      resolveInitialFactor(hardware, { kind: "hardware" }, [], {
        credentialId: new Uint8Array([1]),
        first: new Uint8Array(32),
        second,
        synced: true,
      }),
    ).resolves.toStrictEqual({ kind: "hardware" });
    expect(second.every((byte) => byte === 0)).toBe(true);
  });

  it("refuses software factors before any ceremony", async () => {
    await expect(code(resolveFactor(hardware, { kind: "passkey" }, []))).resolves.toBe(
      "factor-unavailable",
    );
    await expect(
      code(resolveFactor(hardware, { kind: "password", password: "long enough pw" }, [])),
    ).resolves.toBe("factor-unavailable");
    await expect(
      code(resolveInitialFactor(hardware, { kind: "passkey", name: "me" }, [])),
    ).resolves.toBe("factor-unavailable");
  });
});

describe("software host", () => {
  const software = source("software");

  it("defaults unlock to passkey and refuses hardware", async () => {
    expect(defaultUnlockFactor(software)).toStrictEqual({ kind: "passkey" });
    await expect(code(resolveFactor(software, { kind: "hardware" }, []))).resolves.toBe(
      "factor-unavailable",
    );
    await expect(code(resolveInitialFactor(software, { kind: "hardware" }, []))).resolves.toBe(
      "factor-unavailable",
    );
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
