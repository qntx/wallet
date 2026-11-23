/**
 * F-01 React Native backup password crosses the main runtime.
 *
 * On React Native the backup password is produced by the main runtime. The proof: the whole backup
 * path — enable with a hardware verify, update producing the cloud envelope, restore on any host,
 * and a full mnemonic export — completes with the password alone. `backup.update` touches no
 * keystore, so an envelope + the password the main runtime already held is enough to recover the
 * seed on a device that has no keystore at all.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "../harness.ts";
import type { KernelResponse } from "../harness.ts";
import { fakeKeystore } from "../keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error(`expected object, got ${typeof value}`);
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}

const str = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

const bytes = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

const firstOf = (value: ProtocolValue): ProtocolValue => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("expected a non-empty array");
  }
  return value[0] as ProtocolValue;
};

describe("F-01 a main runtime that saw the backup password recovers the seed", () => {
  it("recovers the seed from backup.update's envelope alone", async () => {
    // Fresh bytes per call — the kernel wipes every secret buffer it is handed.
    const backupPassword = () => utf8ToBytes("backup password held by the main runtime");
    const vaultPassword = () => utf8ToBytes("a different vault password for the restored wallet");

    // React Native host: hardware keystore present, seed sealed under device+hardware factors.
    const fake = fakeKeystore();
    const h1 = createHarness({ keystore: fake.keystore });
    await h1.settle();
    const imported = ok(
      await h1.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
    );
    const session = str(imported, "session");

    ok(
      await h1.call(
        "backup.enable",
        { verify: HARDWARE, factors: [{ kind: "password", password: backupPassword() }] },
        session,
      ),
    );

    // The cloud envelope: produced without any keystore call at all.
    const callsBeforeUpdate = fake.calls.length;
    const updated = ok(await h1.call("backup.update", null, session));
    const envelope = str(updated, "envelope");
    expect(fake.calls).toHaveLength(callsBeforeUpdate);

    // Any other host — no keystore — restores with just the backup password…
    const h2 = createHarness();
    await h2.settle();
    const restored = ok(
      await h2.call("backup.restore", {
        envelope,
        backupFactor: { kind: "password", password: backupPassword() },
        factor: { kind: "password", password: vaultPassword() },
      }),
    );
    const walletId = str(firstOf(field(restored, "wallets")), "walletId");

    // …and the restored password factor alone exports the seed, byte-identical.
    const exported = ok(
      await h2.call(
        "wallet.exportMnemonic",
        { verify: { kind: "password", password: vaultPassword() }, walletId },
        str(restored, "session"),
      ),
    );
    expect(new TextDecoder().decode(bytes(exported, "mnemonic"))).toBe(MNEMONIC);
  });
});
