/**
 * The session-factor model on a keystore host (React Native): the silent `device` factor unlocks
 * without presence and can never verify; the `hardware` factor is the only verifier and every
 * guarded command runs one fresh ceremony. App lock is the absence of the device row;
 * `vault.enrolVerification` and `vault.setAppLock` manage the pair.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import type { Keystore } from "../src/platform.ts";
import { corePrompt } from "../src/prompts.ts";
import { Secret } from "../src/secret/secret.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { RecordStore, VaultImage } from "../src/vault/store.ts";
import { verifyFactor } from "../src/vault/vault.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";
import { fakeSecureInput } from "./secure-input.ts";

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

function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return (value as Record<string, ProtocolValue>)[key] as ProtocolValue;
}

const str = (value: ProtocolValue, key: string): string => field(value, key) as string;

const factorsOf = async (h: Harness): Promise<ReadonlyArray<Record<string, ProtocolValue>>> =>
  field(ok(await h.call("status")), "factors") as ReadonlyArray<Record<string, ProtocolValue>>;

const factorKinds = async (h: Harness): Promise<ReadonlyArray<string>> => {
  const factors = await factorsOf(h);
  return factors.map((factor) => factor["kind"] as string);
};

const findFactor = async (
  h: Harness,
  kind: string,
): Promise<Record<string, ProtocolValue> | undefined> => {
  const factors = await factorsOf(h);
  return factors.find((factor) => factor["kind"] === kind);
};

async function establish(h: Harness): Promise<{ session: string; walletId: string }> {
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  return { session: str(res, "session"), walletId: str(field(res, "wallet"), "walletId") };
}

/** A store writer rewrites the store to `image` wholesale (meta included) — no DEK needed. */
async function rewriteStore(store: RecordStore, image: VaultImage): Promise<void> {
  const { meta } = image;
  if (meta === undefined) {
    throw new Error("vault is not initialized");
  }
  await store.commit([{ op: "clear" }]);
  await store.commit([
    { op: "init", meta },
    ...image.factors.map((factor) => ({ op: "put-factor" as const, factor })),
    ...image.records.map((record) => ({ op: "put-record" as const, record })),
  ]);
}

const keystoreCalls = (calls: ReadonlyArray<KeystoreCall>): ReadonlyArray<string> =>
  calls.map((call) => call.op);

describe("device factor: silent unlock", () => {
  it("opens a session without any presence ceremony or UI", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    await establish(createHarness({ keystore: fake.keystore, store }));

    const restarted = createHarness({ keystore: fake.keystore, store });
    await restarted.settle();
    fake.calls.length = 0;
    expect(str(ok(await restarted.call("vault.unlock", { factor: DEVICE })), "session")).toBeTypeOf(
      "string",
    );
    // The only keystore work is the silent device open plus the best-effort hardware probe.
    expect(fake.calls.filter((call) => call.op === "open")).toStrictEqual([
      { op: "open", id: expect.any(String) as string, protection: "device" },
    ]);
    expect(fake.calls.some((call) => "prompt" in call)).toBe(false);
    expect(restarted.events.some((event) => event.event === "ceremony")).toBe(false);
  });
});

describe("device factor cannot verify", () => {
  it("verifyFactor rejects device before any keystore work", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await establish(h);
    void session;
    const image = await h.store.load();
    fake.calls.length = 0;
    const dek = Secret.take(new Uint8Array(32));
    try {
      await expect(
        verifyFactor(
          undefined as never,
          image,
          { kind: "device" } as never,
          dek,
          async () => Promise.resolve(),
          () => ({ title: "", description: "" }),
        ),
      ).rejects.toBeInstanceOf(KernelError);
    } finally {
      dek.wipe();
    }
    expect(fake.calls).toStrictEqual([]);
  });

  it("every guarded method rejects a device verifier without touching the keystore", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await establish(h);
    const imported = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(32).fill(1) }, session),
    );
    const keyId = str(imported, "keyId");
    const derived = ok(await h.call("nostr.deriveKey", { walletId, index: 0 }, session));
    const publicKey = str(derived, "publicKey");
    const guarded: ReadonlyArray<readonly [string, unknown]> = [
      ["wallet.exportMnemonic", { verify: DEVICE, walletId }],
      ["wallet.delete", { verify: DEVICE, walletId }],
      ["keys.export", { verify: DEVICE, keyId }],
      ["keys.remove", { verify: DEVICE, keyId }],
      ["nostr.exportKey", { verify: DEVICE, publicKey, format: { kind: "nsec" } }],
      [
        "backup.enable",
        {
          verify: DEVICE,
          factors: [{ kind: "password", password: utf8ToBytes("backup password") }],
        },
      ],
      ["backup.disable", { verify: DEVICE }],
      [
        "chain.sign",
        {
          verify: DEVICE,
          request: {
            network: "eip155:1",
            account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
            tx: {
              type: "eip1559",
              chainId: 1,
              nonce: 0,
              gas: "0x5208",
              value: "0x0",
              data: "0x",
              to: "0x00000000000000000000000000000000deadbeef",
              maxFeePerGas: "0x59682f00",
              maxPriorityFeePerGas: "0x1",
              accessList: [],
            },
          },
        },
      ],
      [
        "spark.approve",
        {
          verify: DEVICE,
          account: { walletId, groupIndex: 0, network: "regtest" },
          intent: { kind: "onchain", address: "bcrt1qxyz", maxFeeSats: 500 },
        },
      ],
      ["vault.setAppLock", { enabled: true, verify: DEVICE }],
    ];
    for (const [method, params] of guarded) {
      fake.calls.length = 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- guarded calls run one at a time
      const res = await h.call(method, params, session);
      expect(errCode(res)).toBeDefined();
      expect(fake.calls).toStrictEqual([]);
    }
  });
});

describe("no verifying factor", () => {
  it("every guarded command is verification-unavailable and the keystore stays silent", async () => {
    const fake = fakeKeystore();
    fake.removeLockScreen();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await establish(h);
    await expect(factorKinds(h)).resolves.toStrictEqual(["device"]);
    const imported = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(32).fill(1) }, session),
    );
    const keyId = str(imported, "keyId");
    const derived = ok(await h.call("nostr.deriveKey", { walletId, index: 0 }, session));
    const publicKey = str(derived, "publicKey");
    const guarded: ReadonlyArray<readonly [string, unknown]> = [
      ["wallet.exportMnemonic", { verify: HARDWARE, walletId }],
      ["wallet.delete", { verify: HARDWARE, walletId }],
      ["keys.export", { verify: HARDWARE, keyId }],
      ["keys.remove", { verify: HARDWARE, keyId }],
      ["nostr.exportKey", { verify: HARDWARE, publicKey, format: { kind: "nsec" } }],
      ["backup.enable", { verify: HARDWARE, factors: [{ kind: "password", ceremony: "kernel" }] }],
      ["backup.disable", { verify: HARDWARE }],
      ["vault.setAppLock", { enabled: true, verify: HARDWARE }],
    ];
    for (const [method, params] of guarded) {
      fake.calls.length = 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose
      expect(errCode(await h.call(method, params, session))).toBe("verification-unavailable");
      expect(fake.calls).toStrictEqual([]);
    }
  });
});

describe("backup.disable", () => {
  it("re-verifies with hardware and drops the retained backup key in one ceremony", async () => {
    const fake = fakeKeystore();
    const input = fakeSecureInput();
    const h = createHarness({ keystore: fake.keystore, secureInput: input.secureInput });
    const { session } = await establish(h);
    input.answer(utf8ToBytes("backup password for the kernel ceremony"));
    input.answer(utf8ToBytes("backup password for the kernel ceremony"));
    ok(
      await h.call(
        "backup.enable",
        { verify: HARDWARE, factors: [{ kind: "password", ceremony: "kernel" }] },
        session,
      ),
    );
    expect(field(ok(await h.call("status")), "backup")).not.toBeNull();
    const hardware = await findFactor(h, "hardware");
    fake.calls.length = 0;
    ok(await h.call("backup.disable", { verify: HARDWARE }, session));
    expect(field(ok(await h.call("status")), "backup")).toBeNull();
    // Exactly one presence ceremony — the hardware re-verification's open.
    expect(fake.calls).toStrictEqual([
      {
        op: "open",
        id: hardware?.["id"],
        protection: "presence",
        prompt: corePrompt("en", "disable-backup"),
      },
    ]);
  });
});

describe("vault.enrolVerification", () => {
  it("is verification-unavailable without a lock screen and writes nothing", async () => {
    const fake = fakeKeystore();
    fake.removeLockScreen();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await establish(h);
    fake.calls.length = 0;
    expect(errCode(await h.call("vault.enrolVerification", null, session))).toBe(
      "verification-unavailable",
    );
    await expect(factorKinds(h)).resolves.toStrictEqual(["device"]);
    expect(fake.calls.filter((call) => call.op === "seal")).toHaveLength(1);
  });

  it("is already-exists while a live hardware row exists", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await establish(h);
    expect(errCode(await h.call("vault.enrolVerification", null, session))).toBe("already-exists");
  });

  it("replaces a dead hardware row", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await establish(h);
    const hardwareRow = await findFactor(h, "hardware");
    fake.invalidate(hardwareRow?.["id"] as string);
    ok(await h.call("vault.enrolVerification", null, session));
    const factors = await factorsOf(h);
    expect(factors.map((factor) => factor["kind"])).toStrictEqual(["device", "hardware"]);
    const replacement = factors.find((factor) => factor["kind"] === "hardware");
    expect(replacement?.["id"]).not.toBe(hardwareRow?.["id"]);
    // The replacement verifies.
    const status = ok(await h.call("status"));
    const walletId = str(
      (field(status, "wallets") as ReadonlyArray<ProtocolValue>)[0] as ProtocolValue,
      "walletId",
    );
    ok(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session));
  });
});

describe("vault.setAppLock", () => {
  it("enabling rotates the DEK, drops the device row and invalidates foreign sessions", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    const { session, walletId } = await establish(h);
    const imageBefore = await h.store.load();
    const keyIdBefore = imageBefore.meta?.keyId;
    const deviceRow = await findFactor(h, "device");

    // A second kernel sharing the store holds a session of its own.
    const other = createHarness({ keystore: fake.keystore, store });
    const otherSession = str(ok(await other.call("vault.unlock", { factor: DEVICE })), "session");

    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));

    const image = await h.store.load();
    expect(image.meta?.keyId).not.toBe(keyIdBefore);
    await expect(factorKinds(h)).resolves.toStrictEqual(["hardware"]);
    expect(fake.keys.has(deviceRow?.["id"] as string)).toBe(false);
    // Every record still opens — the live session can export under the rotated DEK.
    fake.calls.length = 0;
    ok(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session));
    expect(keystoreCalls(fake.calls)).toStrictEqual(["open"]);
    // The foreign kernel's session is invalidated by the key-id change.
    await other.settle();
    expect(
      errCode(
        await other.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, otherSession),
      ),
    ).toBeDefined();
    expect(field(ok(await other.call("status")), "vault")).toBe("locked");

    // Device unlock is gone; hardware unlock prompts.
    expect(errCode(await h.call("vault.unlock", { factor: DEVICE }))).toBe("not-found");
    const locked = createHarness({ keystore: fake.keystore, store });
    await locked.settle();
    fake.calls.length = 0;
    ok(await locked.call("vault.unlock", { factor: HARDWARE }));
    expect(fake.calls.some((call) => "prompt" in call)).toBe(true);
  });

  it("disabling restores the device row and silent unlock; repeats are no-ops", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    const { session } = await establish(h);
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));

    // Idempotent: already enabled — no prompt, no change.
    fake.calls.length = 0;
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    expect(fake.calls).toStrictEqual([]);

    ok(await h.call("vault.setAppLock", { enabled: false, verify: HARDWARE }, session));
    await expect(factorKinds(h)).resolves.toStrictEqual(["hardware", "device"]);

    // Idempotent again: already disabled — no prompt, no change.
    fake.calls.length = 0;
    ok(await h.call("vault.setAppLock", { enabled: false, verify: HARDWARE }, session));
    expect(fake.calls).toStrictEqual([]);

    const restarted = createHarness({ keystore: fake.keystore, store });
    await restarted.settle();
    fake.calls.length = 0;
    ok(await restarted.call("vault.unlock", { factor: DEVICE }));
    expect(fake.calls.some((call) => "prompt" in call)).toBe(false);
  });

  it("enabling destroys the device key before the vault stops using it", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    const { session } = await establish(h);
    const before = await store.load();
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));

    // A store writer puts the whole pre-app-lock image back: its device row has no key left.
    await rewriteStore(store, before);
    const rolledBack = createHarness({ keystore: fake.keystore, store });
    await rolledBack.settle();
    expect(errCode(await rolledBack.call("vault.unlock", { factor: DEVICE }))).toBeDefined();
  });

  it("a device key the keystore cannot remove leaves the app lock off", async () => {
    const fake = fakeKeystore();
    const keystore: Keystore = {
      ...fake.keystore,
      remove: async () => Promise.reject(new Error("keystore remove failed")),
    };
    const store = createMemoryStore();
    const h = createHarness({ keystore, store });
    const { session } = await establish(h);
    const before = await store.load();
    const deviceRow = await findFactor(h, "device");

    expect(
      errCode(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session)),
    ).toBe("unavailable");
    await expect(store.load()).resolves.toStrictEqual(before);
    expect(fake.keys.has(deviceRow?.["id"] as string)).toBe(true);
    await expect(factorKinds(h)).resolves.toStrictEqual(["device", "hardware"]);
  });
});

describe("dead hardware factor cleanup", () => {
  it("device unlock probes and drops a dead hardware row", async () => {
    const fake = fakeKeystore();
    const store = createMemoryStore();
    const h = createHarness({ keystore: fake.keystore, store });
    await establish(h);
    const hardwareRow = await findFactor(h, "hardware");
    fake.invalidate(hardwareRow?.["id"] as string);

    const restarted = createHarness({ keystore: fake.keystore, store });
    await restarted.settle();
    ok(await restarted.call("vault.unlock", { factor: DEVICE }));
    await expect(factorKinds(restarted)).resolves.toStrictEqual(["device"]);
  });

  it("a guarded open drops the dead row and reports verification-unavailable", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await establish(h);
    const hardwareRow = await findFactor(h, "hardware");
    fake.invalidate(hardwareRow?.["id"] as string);
    expect(
      errCode(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session)),
    ).toBe("verification-unavailable");
    await expect(factorKinds(h)).resolves.toStrictEqual(["device"]);
  });

  it("with the app lock on the row stays and factor-invalidated surfaces", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await establish(h);
    ok(await h.call("vault.setAppLock", { enabled: true, verify: HARDWARE }, session));
    const hardwareRow = await findFactor(h, "hardware");
    fake.invalidate(hardwareRow?.["id"] as string);
    expect(
      errCode(await h.call("wallet.exportMnemonic", { verify: HARDWARE, walletId }, session)),
    ).toBe("factor-invalidated");
    await expect(factorKinds(h)).resolves.toStrictEqual(["hardware"]);
  });
});

describe("establish on a keystore host", () => {
  it("a lock screen yields device + hardware rows", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    await establish(h);
    await expect(factorKinds(h)).resolves.toStrictEqual(["device", "hardware"]);
    expect(field(ok(await h.call("status")), "appLock")).toBe(false);
    expect(field(ok(await h.call("status")), "verification")).toBe("available");
  });

  it("no lock screen yields device only and reports verification unavailable", async () => {
    const fake = fakeKeystore();
    fake.removeLockScreen();
    const h = createHarness({ keystore: fake.keystore });
    await establish(h);
    await expect(factorKinds(h)).resolves.toStrictEqual(["device"]);
    expect(field(ok(await h.call("status")), "verification")).toBe("unavailable");
  });

  it("a cancelled hardware seal fails the whole establish and clears keys", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    fake.fail("cancelled");
    expect(
      errCode(
        await h.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(MNEMONIC),
          factor: DEVICE,
        }),
      ),
    ).toBe("cancelled");
    expect(fake.keys.size).toBe(0);
    expect(field(ok(await h.call("status")), "vault")).toBe("uninitialized");
    expect(keystoreCalls(fake.calls)).toStrictEqual(["clear", "seal", "seal", "clear"]);
  });

  it("addFactor and removeFactor are unsupported before any prompt", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session } = await establish(h);
    expect(
      errCode(await h.call("vault.addFactor", { verify: HARDWARE, factor: HARDWARE }, session)),
    ).toBe("unsupported");
    expect(
      errCode(
        await h.call("vault.removeFactor", { verify: HARDWARE, id: "0".repeat(32) }, session),
      ),
    ).toBe("unsupported");
    expect(fake.calls.filter((call) => call.op === "open")).toStrictEqual([]);
  });
});
