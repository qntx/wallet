/**
 * The session-factor model on a keystore host (React Native): the silent `device` factor unlocks
 * without presence and can never verify; the `hardware` factor is the only verifier and every
 * guarded command runs one fresh ceremony. App lock is the absence of the device row;
 * `vault.enrolVerification` and `vault.setAppLock` manage the pair; a format-3 vault upgrades to
 * format 4 on first unlock.
 */
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { Secret } from "../src/secret/secret.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { RecordStore, StoreOp } from "../src/vault/store.ts";
import { VAULT_FORMAT } from "../src/vault/store.ts";
import { verifyFactor } from "../src/vault/vault.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

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
        { verify: DEVICE, factors: [{ kind: "password", password: utf8ToBytes("backup pw") }] },
      ],
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
      [
        "backup.enable",
        { verify: HARDWARE, factors: [{ kind: "password", password: utf8ToBytes("backup pw") }] },
      ],
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

type V013 = {
  readonly dek: string;
  readonly kek: string;
  readonly factorId: string;
  readonly walletId: string;
  readonly nostrPublicKey: string;
  readonly image: {
    meta: Record<string, unknown>;
    factors: ReadonlyArray<{ kind: string; id: string; header: string; sealed: string }>;
    records: ReadonlyArray<{ kind: string; id: string; header: string; sealed: string }>;
  };
};

const v013 = loadVectors("vault-v013.json") as V013;

/** A store wrapper that rejects any commit carrying a `set-format` op until released. */
function breakOnSetFormat(): { wrap: (store: RecordStore) => RecordStore; release: () => void } {
  let broken = true;
  return {
    wrap: (inner) => ({
      ...inner,
      commit: async (ops) => {
        if (broken && ops.some((op) => op.op === "set-format")) {
          throw new KernelError("unavailable", "commit failed");
        }
        await inner.commit(ops);
      },
    }),
    release: () => {
      broken = false;
    },
  };
}

async function seedV013(store: RecordStore): Promise<void> {
  const factorOps: StoreOp[] = v013.image.factors.map((factor) => ({
    op: "put-factor",
    factor: {
      kind: factor.kind,
      id: factor.id,
      header: factor.header,
      sealed: hexToBytes(factor.sealed),
    },
  }));
  const recordOps: StoreOp[] = v013.image.records.map((record) => ({
    op: "put-record",
    record: {
      kind: record.kind,
      id: record.id,
      header: record.header,
      sealed: hexToBytes(record.sealed),
    },
  }));
  const ops: StoreOp[] = [
    { op: "init", meta: v013.image.meta as never },
    ...factorOps,
    ...recordOps,
  ];
  await store.commit(ops);
}

function v013Keystore(): ReturnType<typeof fakeKeystore> {
  const fake = fakeKeystore();
  fake.adopt(v013.factorId, hexToBytes(v013.kek), "presence");
  return fake;
}

describe("format-3 upgrade", () => {
  it("hardware unlock upgrades to format 4, adds a device row, keeps wallet and nostr key", async () => {
    const fake = v013Keystore();
    const store = createMemoryStore();
    await seedV013(store);
    const h = createHarness({ keystore: fake.keystore, store });
    await h.settle();
    expect(str(ok(await h.call("vault.unlock", { factor: HARDWARE })), "session")).toBeTypeOf(
      "string",
    );
    const image = await h.store.load();
    expect(image.meta?.format).toBe(VAULT_FORMAT);
    await expect(factorKinds(h)).resolves.toStrictEqual(["hardware", "device"]);
    const status = ok(await h.call("status"));
    const wallets = field(status, "wallets") as ReadonlyArray<ProtocolValue>;
    expect(str(wallets[0] as ProtocolValue, "walletId")).toBe(v013.walletId);
    const keys = field(field(status, "nostr"), "keys") as ReadonlyArray<ProtocolValue>;
    expect(str(keys[0] as ProtocolValue, "publicKey")).toBe(v013.nostrPublicKey);
  });

  it("device unlock on the format-3 image is not-found and writes nothing", async () => {
    const fake = v013Keystore();
    const store = createMemoryStore();
    await seedV013(store);
    const h = createHarness({ keystore: fake.keystore, store });
    await h.settle();
    expect(errCode(await h.call("vault.unlock", { factor: DEVICE }))).toBe("not-found");
    const image = await h.store.load();
    expect(image.meta?.format).toBe(3);
    expect(image.factors).toHaveLength(1);
  });

  it("a failing upgrade commit opens no session", async () => {
    const fake = v013Keystore();
    const store = createMemoryStore();
    await seedV013(store);
    const breaker = breakOnSetFormat();
    const h = createHarness({
      keystore: fake.keystore,
      store,
      wrapStore: breaker.wrap,
    });
    await h.settle();
    expect(errCode(await h.call("vault.unlock", { factor: HARDWARE }))).toBeDefined();
    breaker.release();
    expect(field(ok(await h.call("status")), "vault")).toBe("locked");
    const failedImage = await h.store.load();
    expect(failedImage.meta?.format).toBe(3);
  });

  it("a software host upgrades a format-3 password vault without factor changes", async () => {
    const store = createMemoryStore();
    const plain = createHarness({ store });
    await plain.settle();
    ok(
      await plain.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "password", password: utf8ToBytes("correct horse battery staple") },
      }),
    );
    // Back-date the vault to format 3 exactly as an older build left it.
    await store.commit([{ op: "set-format", format: 3 }]);
    const beforeImage = await store.load();
    const before = beforeImage.factors.map((factor) => factor.id);

    const restarted = createHarness({ store });
    await restarted.settle();
    ok(
      await restarted.call("vault.unlock", {
        factor: { kind: "password", password: utf8ToBytes("correct horse battery staple") },
      }),
    );
    const image = await store.load();
    expect(image.meta?.format).toBe(VAULT_FORMAT);
    expect(image.factors.map((factor) => factor.id)).toStrictEqual(before);
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
