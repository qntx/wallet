/**
 * An authenticated `hardware-wallet` record whose device kind this build does not know stays inert:
 * status lists it with `supported: false`, the pin's body is never parsed, every driven operation —
 * accounts, verify-address, sign, `wallet.accounts`, `chain.sign` — answers `unsupported`, the
 * vault stays `ok`, and `wallet.delete` removes it. A malformed device string is not "unknown": it
 * still latches the vault corrupted at reconcile.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { PinnedKeys } from "../src/derive/pinned.ts";
import {
  encodeHardwareBody,
  encodeHardwareHeader,
  HARDWARE_WALLET_KIND,
  hardwareWalletId,
} from "../src/modules/signers/record.ts";
import type { HardwareHeader } from "../src/modules/signers/record.ts";
import type { Secret } from "../src/secret/secret.ts";
import { wipe } from "../src/secret/secret.ts";
import { passkeyKek, unwrapDek } from "../src/vault/factors.ts";
import { withManifest } from "../src/vault/manifest.ts";
import { sealRecord } from "../src/vault/vault.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeDevice, masterFingerprint, nodeAt } from "./signers-fake.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);
const MFP = masterFingerprint(SEED);
const T0 = 1_700_000_000_000;

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF = new Uint8Array(32).fill(0x50);
const FACTOR = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF),
});
const PASSKEY = (): unknown => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF),
});

const sealer = {
  random: (n: number) => new Uint8Array(n).fill(3),
  now: () => T0,
} as never;

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error(`expected object, got ${String(value)}`);
  }
  const v = (value as Record<string, ProtocolValue>)[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}
const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};
const arrField = (value: ProtocolValue, key: string): ProtocolValue[] => {
  const v = field(value, key);
  if (!Array.isArray(v)) {
    throw new TypeError(`${key} is not an array`);
  }
  return v;
};

const boot = async (): Promise<{ h: Harness; session: string }> => {
  const device = fakeDevice(SEED);
  const h = createHarness({ drivers: { keystone: device.driver, ledger: device.driver } });
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: FACTOR(),
    }),
  );
  return { h, session: strField(res, "session") };
};

/** Unwraps the live session DEK the same way unlock did — from the test passkey factor's KEK. */
const sessionDek = async (h: Harness): Promise<Secret> => {
  const image = await h.store.load();
  const factor = image.factors.find((f) => f.kind === "passkey");
  if (factor === undefined) {
    throw new Error("missing passkey factor");
  }
  const kek = passkeyKek(PRF, CREDENTIAL_ID);
  try {
    return unwrapDek(kek, factor);
  } finally {
    wipe(kek);
  }
};

/**
 * Plants a `hardware-wallet` record directly in the store — like a commit written by another build
 * that knew this device kind; the kernel reconciles and claims (or skips) its body.
 */
const plantHardwareWallet = async (
  h: Harness,
  device: string,
  body: Uint8Array,
): Promise<string> => {
  const fingerprint = MFP;
  const header: HardwareHeader = { device, fingerprint, createdAt: T0 };
  const id = hardwareWalletId(device, fingerprint);
  const dek = await sessionDek(h);
  try {
    const image = await h.store.load();
    const record = sealRecord(
      sealer,
      dek,
      HARDWARE_WALLET_KIND,
      id,
      encodeHardwareHeader(header),
      body,
    );
    await h.store.commit(withManifest(sealer, image, [{ op: "put-record", record }], dek));
  } finally {
    dek.wipe();
  }
  await h.settle();
  return id;
};

const realBody = (): Uint8Array => {
  const keys: PinnedKeys = {
    nodes: [nodeAt(SEED, [44 + 0x80000000, 60 + 0x80000000, 0x80000000])],
    ed25519: [],
  };
  return encodeHardwareBody(keys);
};

const walletEntry = (status: ProtocolValue, walletId: string): ProtocolValue => {
  const entry = arrField(status, "wallets").find((w) => strField(w, "walletId") === walletId);
  if (entry === undefined) {
    throw new Error(`wallet ${walletId} missing from status`);
  }
  return entry;
};

const EVM_SIGN_REQUEST = (walletId: string): unknown => ({
  kind: "evm.transaction",
  network: "eip155:1",
  account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
  tx: {
    type: "legacy",
    chainId: 1,
    nonce: 0,
    gas: "0x5208",
    gasPrice: "0x4a817c800",
    value: "0xde0b6b3a7640000",
    data: "0x",
    to: "0x00000000000000000000000000000000deadbeef",
  },
});

describe("unknown hardware device kind stays inert", () => {
  it("status lists the wallet with supported: false and the vault stays ok", async () => {
    const { h, session } = await boot();
    const walletId = await plantHardwareWallet(h, "trezor", realBody());
    const status = ok(await h.call("status", null, session));
    // An ok vault reports its session state; only non-ok health shadows it.
    expect(strField(status, "vault")).toBe("unlocked");
    const entry = walletEntry(status, walletId);
    expect(strField(entry, "custody")).toBe("hardware");
    expect(strField(entry, "device")).toBe("trezor");
    expect(field(entry, "supported")).toBe(false);
  });

  it("an unknown device never even parses its sealed body", async () => {
    const { h, session } = await boot();
    // Bytes that would fail every body rule — valid ciphertext, inert because the kind is unknown.
    const walletId = await plantHardwareWallet(h, "trezor", utf8ToBytes("not json"));
    const status = ok(await h.call("status", null, session));
    expect(strField(status, "vault")).toBe("unlocked");
    expect(field(walletEntry(status, walletId), "supported")).toBe(false);
  });

  it("accounts, verify-address, sign, wallet.accounts and chain.sign all answer unsupported", async () => {
    const { h, session } = await boot();
    const walletId = await plantHardwareWallet(h, "trezor", realBody());
    expect(
      errCode(
        await h.call(
          "hardware.begin",
          {
            op: {
              kind: "accounts",
              walletId,
              groupIndex: 0,
              templates: ["evm.bip44"],
              network: "eip155:1",
            },
          },
          session,
        ),
      ),
    ).toBe("unsupported");
    expect(
      errCode(
        await h.call(
          "hardware.begin",
          {
            op: {
              kind: "verify-address",
              walletId,
              groupIndex: 0,
              template: "evm.bip44",
              network: "eip155:1",
            },
          },
          session,
        ),
      ),
    ).toBe("unsupported");
    expect(
      errCode(
        await h.call(
          "hardware.begin",
          { op: { kind: "sign", request: EVM_SIGN_REQUEST(walletId) }, verify: PASSKEY() },
          session,
        ),
      ),
    ).toBe("unsupported");
    expect(
      errCode(
        await h.call(
          "wallet.accounts",
          { walletId, template: "evm.bip44", network: "eip155:1", groupIndex: 0 },
          session,
        ),
      ),
    ).toBe("unsupported");
    // chain.sign never reaches the blind-signing gate or the verify prompt on an inert wallet.
    expect(
      errCode(
        await h.call(
          "chain.sign",
          { request: EVM_SIGN_REQUEST(walletId), verify: PASSKEY() },
          session,
        ),
      ),
    ).toBe("unsupported");
  });

  it("wallet.delete removes the inert wallet and the vault stays ok", async () => {
    const { h, session } = await boot();
    const walletId = await plantHardwareWallet(h, "trezor", realBody());
    ok(await h.call("wallet.delete", { walletId, verify: PASSKEY() }, session));
    const status = ok(await h.call("status", null, session));
    expect(strField(status, "vault")).toBe("unlocked");
    expect(
      arrField(status, "wallets").find((w) => strField(w, "walletId") === walletId),
    ).toBeUndefined();
  });

  it("a malformed device string latches the vault corrupted at reconcile", async () => {
    const { h, session } = await boot();
    await plantHardwareWallet(h, "Trezor-3", realBody());
    const status = ok(await h.call("status", null, session));
    expect(strField(status, "vault")).toBe("corrupted");
  });
});
