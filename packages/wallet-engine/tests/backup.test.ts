import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

/**
 * BackupController over a REAL Node kernel + a memory CloudStore (wrapped to inject failures and
 * foreign writes). The kernel keeps the BEK; the engine only ever moves ciphertext. Every upload
 * lands as a new `qntx-wallet-backup-<id>-<sha256(text)>.json` file — coverage changes produce new
 * names and superseded names are deleted once the new head is confirmed.
 */
import { verifyEvent } from "@qntx/nostr";
import type { Wallet, WalletInfo } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import { BackupControllerError } from "../src/backup/errors.ts";
import { createMemoryCloudStore } from "../src/backup/memory.ts";
import { CloudStoreError } from "../src/backup/port.ts";
import type { CloudStore } from "../src/backup/port.ts";
import { backupPasswordStrength } from "../src/backup/strength.ts";
import { createWalletEngine } from "../src/engine.ts";
import type { EngineLogger } from "../src/events.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const BACKUP_PASSWORD = "cloud backup password!";
const PASSKEY_CONFIG = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};
const PW = { kind: "password" as const, password: PASSWORD };
const BPW = { kind: "password" as const, password: BACKUP_PASSWORD };
const FILE_NAME = /^qntx-wallet-backup-[0-9a-f]{32}-[0-9a-f]{64}\.json$/;

const LOGGER: EngineLogger = { warn: () => {} };

/** Corrupts exactly the first non-empty read — the read-back check then surfaces `error`. */
function corruptFirstRead(inner: CloudStore): CloudStore {
  let used = false;
  return {
    list: async () => inner.list(),
    read: async (name) => {
      const text = await inner.read(name);
      if (text === undefined || used) {
        return text;
      }
      used = true;
      return `${text}corrupt`;
    },
    write: async (name, text) => inner.write(name, text),
    delete: async (name) => inner.delete(name),
  };
}

type Rig = {
  readonly wallet: Wallet;
  readonly cloud: CloudStore;
  readonly files: Map<string, string>;
  readonly storeBacking: Map<string, Map<string, Uint8Array>>;
  /** One-shot hooks the engine store runs before `put`, keyed by `collection\0key`. */
  readonly storeHooks: Map<string, () => Promise<void>>;
  readonly faults: {
    write: boolean;
    read: boolean;
    del: boolean;
    /** When set, every list() throws it. */
    list: unknown;
    /** Next write lands, then throws like a timed-out call. */
    landThenThrow: boolean;
    /** Next write lands; the following read serves the pre-write value once (eventual consistency). */
    lagRead: boolean;
    stale: { readonly v: string | undefined } | undefined;
    writeCalls: number;
    stall: Promise<void> | undefined;
    stallCalls: number;
  };
  readonly engine: ReturnType<typeof createWalletEngine>;
  readonly close: () => Promise<void>;
};

async function rig(opts: { cloud?: boolean } = {}): Promise<Rig> {
  const wallet = await createNodeWallet({
    verifyEvent,
    passkey: PASSKEY_CONFIG,
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  const files = new Map<string, string>();
  const inner = createMemoryCloudStore(files);
  const faults = {
    write: false,
    read: false,
    del: false,
    list: undefined as unknown,
    landThenThrow: false,
    lagRead: false,
    stale: undefined as { readonly v: string | undefined } | undefined,
    writeCalls: 0,
    stall: undefined as Promise<void> | undefined,
    stallCalls: 0,
  };
  const cloud: CloudStore = {
    list: async () => {
      if (faults.list !== undefined) {
        throw faults.list;
      }
      return inner.list();
    },
    read: async (name) => {
      if (faults.read) {
        throw new Error("read failed");
      }
      if (faults.stale !== undefined) {
        const { v } = faults.stale;
        faults.stale = undefined;
        return v;
      }
      return inner.read(name);
    },
    write: async (name, text) => {
      if (faults.write) {
        throw new Error("write failed");
      }
      const { stall } = faults;
      if (stall !== undefined) {
        // One-shot: parks exactly one in-flight write; releasing it aborts the write like a
        // timed-out cloud call.
        faults.stall = undefined;
        faults.stallCalls += 1;
        await stall;
        throw new Error("stalled write aborted");
      }
      faults.writeCalls += 1;
      if (faults.lagRead) {
        faults.lagRead = false;
        faults.stale = { v: await inner.read(name) };
        return inner.write(name, text);
      }
      if (faults.landThenThrow) {
        faults.landThenThrow = false;
        await inner.write(name, text);
        throw new Error("write timed out after landing");
      }
      return inner.write(name, text);
    },
    delete: async (name) => {
      if (faults.del) {
        throw new Error("delete failed");
      }
      return inner.delete(name);
    },
  };
  const storeBacking = new Map<string, Map<string, Uint8Array>>();
  const storeHooks = new Map<string, () => Promise<void>>();
  const engine = createWalletEngine({
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: async () => Promise.reject(new Error("offline")),
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: LOGGER,
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(persistentEngineStore(storeBacking, storeHooks)),
    ...(opts.cloud === false ? {} : { cloud }),
  });
  return {
    wallet,
    cloud,
    files,
    storeBacking,
    storeHooks,
    faults,
    engine,
    close: async () => {
      engine.unsubscribe();
      await wallet.destroy();
    },
  };
}

async function vaultWithMnemonic(wallet: Wallet): Promise<WalletInfo> {
  const draft = await wallet.wallets.createMnemonic({
    words: 12,
    factor: { kind: "password", password: PASSWORD },
  });
  const words = new TextDecoder().decode(draft.words.read()).split(" ");
  return draft.confirm(draft.quiz.map((p) => words[p]!));
}

async function settle(r: Rig): Promise<void> {
  await r.engine.backup.sync();
}

/** Polls until a read satisfies the predicate — settles engine state without calling sync(). */
async function until<T>(read: () => T, want: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (want(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`until() timed out on ${JSON.stringify(value)}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling is the point
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const isSettled = (s: string): boolean => s === "synced" || s === "conflict" || s === "error";

const tick = Promise.resolve();

/**
 * A persistent EngineStore for lock/unlock tests: records survive close(), the way IndexedDB does —
 * unlike createMemoryEngineStore, which clears its backing on close.
 */
function persistentEngineStore(
  backing: Map<string, Map<string, Uint8Array>>,
  hooks?: Map<string, () => Promise<void>>,
): EngineStore {
  return {
    collection(name: string) {
      let table = backing.get(name);
      if (table === undefined) {
        table = new Map<string, Uint8Array>();
        backing.set(name, table);
      }
      return {
        get: async (key) => {
          await tick;
          return table.get(key);
        },
        put: async (key, bytes) => {
          await tick;
          await hooks?.get(`${name}${key}`)?.();
          table.set(key, bytes);
        },
        delete: async (key) => {
          await tick;
          table.delete(key);
        },
        list: async () => {
          await tick;
          return [...table.keys()];
        },
      };
    },
    close: async () => {
      await tick;
    },
  };
}

function remoteName(files: Map<string, string>): string {
  const names = [...files.keys()];
  if (names.length !== 1) {
    throw new Error(`expected exactly one remote file, got ${names.join(",")}`);
  }
  return names[0]!;
}

// Every backup password here is stretched with the real Argon2id (64 MiB, 3 passes) inside the
// kernel worker, in pure JS: a test that enables and restores pays for it several times.
vi.setConfig({ testTimeout: 30_000 });

describe("BackupController", () => {
  it("no cloud store → unavailable; unprotected lists only wallets with no own backup", async () => {
    const r = await rig({ cloud: false });
    try {
      const mnemonic = await vaultWithMnemonic(r.wallet);
      const passkey = await r.wallet.wallets.createWithPasskey({ name: "passkey wallet" });
      await settle(r);
      const s = r.engine.backup.getState();
      expect(s.status).toBe("unavailable");
      // A mnemonic-exportable wallet is protected by its words; the passkey one is not.
      expect(s.unprotected.walletIds).toStrictEqual([passkey.walletId]);
      expect(mnemonic.backup).toBe("mnemonic");
    } finally {
      await r.close();
    }
  });

  it("enable → versioned remote file, read-back, synced, unprotected empty", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const s = r.engine.backup.getState();
      expect(s.status).toBe("synced");
      expect(s.unprotected.walletIds).toStrictEqual([]);
      const name = remoteName(r.files);
      expect(name).toMatch(FILE_NAME);
      const listed = await r.engine.backup.list();
      expect(listed.map((f) => f.name)).toStrictEqual([name]);
      const { header: firstHeader } = listed[0]!;
      expect(firstHeader.wallets).toHaveLength(1);
      expect(firstHeader.keys).toStrictEqual([]);
    } finally {
      await r.close();
    }
  });

  it("import / delete changes each upload a new version and delete the superseded one", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const first = remoteName(r.files);

      // Import a second mnemonic wallet → a new versioned file; the first is superseded.
      const draft = await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      let listed = await r.engine.backup.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.header.wallets).toHaveLength(2);
      const second = remoteName(r.files);
      expect(second).not.toBe(first);
      expect(r.files.has(first)).toBe(false);

      // Delete the wallet → back to 1 wallet, another new file.
      await r.wallet.wallets.delete(draft.walletId, PW);
      await settle(r);
      listed = await r.engine.backup.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.header.wallets).toHaveLength(1);
      expect(remoteName(r.files)).not.toBe(second);
      expect(r.files.has(second)).toBe(false);
    } finally {
      await r.close();
    }
  });

  it("foreign version → conflict; own-lineage restore merges and syncs the superset", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });

      // Another device of the same backup lineage uploads a wallet this one does not hold:
      // recorded here by importing it, syncing, then deleting it again and resurrecting the file.
      const foreign = await r.wallet.wallets.importMnemonic({
        mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
      });
      await settle(r);
      const foreignName = remoteName(r.files);
      const foreignText = r.files.get(foreignName)!;
      await r.wallet.wallets.delete(foreign.walletId, PW);
      await settle(r);
      r.files.set(foreignName, foreignText);

      // This device changes coverage differently → the foreign version's header coverage is
      // not contained in the local coverage → conflict.
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      expect(r.engine.backup.getState().status).toBe("conflict");
      expect(r.files.has(foreignName)).toBe(true); // foreign versions are never deleted

      // Own-lineage restore merges the foreign file, then the next sync uploads the superset:
      // this device's two wallets plus the foreign one — and prunes the foreign file.
      const merged = await r.engine.backup.restore({ name: foreignName, backupFactor: BPW });
      expect(merged.wallets.map((w) => w.walletId)).toStrictEqual([foreign.walletId]);
      await settle(r);
      expect(r.engine.backup.getState().status).toBe("synced");
      const listed = await r.engine.backup.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.header.wallets).toHaveLength(3);
      expect(r.files.has(foreignName)).toBe(false);
    } finally {
      await r.close();
    }
  });

  it("re-enable writes a new file and deletes the old one", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const first = remoteName(r.files);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const second = remoteName(r.files);
      expect(second).not.toBe(first);
      expect(r.files.has(first)).toBe(false);
    } finally {
      await r.close();
    }
  });

  it("disable deletes the file; a failing delete is retried on the next reconcile", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);
      r.faults.del = true;
      await expect(r.engine.backup.disable(PW)).rejects.toThrow("backup sync failed");
      expect(r.files.has(name)).toBe(true); // deletion failed, file survives
      r.faults.del = false;
      await settle(r);
      expect(r.files.has(name)).toBe(false); // retried
      expect(r.engine.backup.getState().status).toBe("off");
    } finally {
      await r.close();
    }
  });

  it("a password restore into a fresh vault leaves the file alone and backup off", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);
      const original = r.files.get(name)!;

      // Second device, uninitialized vault: the backup password crossed the host, so the kernel
      // restores the wallets without adopting the file's backup key.
      const wallet2 = await createNodeWallet({
        verifyEvent,
        passkey: PASSKEY_CONFIG,
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: KERNEL_URL,
      });
      const engine2 = createWalletEngine({
        publicStore: createMemoryPublicStore(),
        verifyEvent,
        weblnAlias: "test",
        lightningMaxFee: () => 0,
        wallet: wallet2,
        sparkNetwork: "regtest",
        fetch: async () => Promise.reject(new Error("offline")),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: LOGGER,
        showCallsStatus: () => undefined,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        cloud: r.cloud,
      });
      try {
        const restored = await engine2.backup.restore({
          name,
          backupFactor: BPW,
          factor: { kind: "password", password: PASSWORD },
        });
        expect(restored.wallets).toHaveLength(1);
        expect(wallet2.getSnapshot().backup).toBeNull();
        const state = await until(
          () => engine2.backup.getState().status,
          (s) => s === "off",
        );
        expect(state).toBe("off");
        expect([...r.files.keys()]).toStrictEqual([name]);
        expect(r.files.get(name)).toBe(original);

        // Turning backup on there is the owner's own verified decision: a new key, a new file.
        await engine2.backup.enable({ verify: PW, factors: [BPW] });
        expect(r.files.size).toBe(2);
        expect(r.files.get(name)).toBe(original);
      } finally {
        engine2.unsubscribe();
        await wallet2.destroy();
      }
    } finally {
      await r.close();
    }
  });

  it("a restore of a foreign-lineage file records nothing", async () => {
    const r = await rig();
    const other = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      await vaultWithMnemonic(other.wallet);
      await other.engine.backup.enable({ verify: PW, factors: [BPW] });
      const foreign = [...other.files.keys()][0]!;
      const foreignText = other.files.get(foreign)!;
      // Copy the other device's file into our cloud under its own name — a different backup id.
      r.files.set(foreign, foreignText);

      const restored = await r.engine.backup.restore({ name: foreign, backupFactor: BPW });
      expect(restored.wallets).toHaveLength(1);
      expect(r.engine.backup.getState().status).toBe("synced");
      // The foreign file is of another backup id entirely: it is not ours, so it stays.
      expect(r.files.has(foreign)).toBe(true);
    } finally {
      await r.close();
      await other.close();
    }
  });

  it("a corrupt version (digest mismatch) fails restore and reads as absent in list", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);
      r.files.set(name, `${r.files.get(name)!}corrupt`);

      await expect(r.engine.backup.restore({ name, backupFactor: BPW })).rejects.toMatchObject({
        name: "BackupControllerError",
        category: "cloud",
      });
      await expect(r.engine.backup.list()).resolves.toStrictEqual([]);
    } finally {
      await r.close();
    }
  });

  it("a foreign version whose name digest does not match its text is ignored", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const backupId = remoteName(r.files).split("-")[3]!;

      // A real envelope covering a wallet this device does not hold, filed under a name whose
      // digest belongs to nothing: it fails verification and must not read as a conflict.
      const foreign = await r.wallet.wallets.importMnemonic({
        mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
      });
      await settle(r);
      const foreignText = r.files.get(remoteName(r.files))!;
      await r.wallet.wallets.delete(foreign.walletId, PW);
      await settle(r);
      r.files.set(`qntx-wallet-backup-${backupId}-${"0".repeat(64)}.json`, foreignText);
      await settle(r);

      expect(r.engine.backup.getState().status).toBe("synced");
      expect(r.files.has(`qntx-wallet-backup-${backupId}-${"0".repeat(64)}.json`)).toBe(true);
    } finally {
      await r.close();
    }
  });

  it("lock during an in-flight sync: no cloud or store writes land afterwards", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);

      // Change coverage and stall the cloud write so the reconcile is in flight at lock time.
      let release!: () => void;
      r.faults.stall = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await until(
        () => r.faults.stallCalls,
        (n) => n === 1,
      );
      const before = new Map(r.files);
      await r.wallet.vault.lock();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(r.engine.backup.getState().status).toBe("locked");
      expect(r.files).toStrictEqual(before); // the pending upload never landed
      expect(r.files.get(name)).toBeDefined();
    } finally {
      await r.close();
    }
  });

  it("lock while the staged record write is parked: the upload never reaches the cloud", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const before = new Map(r.files);

      // Coverage change → pass → staged record put parks mid-pass; lock lands inside the parked
      // write so the pre-write generation check is what keeps the cloud write from being issued.
      let release!: () => void;
      let parked = 0;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      r.storeHooks.set("backupstate", async () => {
        r.storeHooks.delete("backupstate");
        parked += 1;
        await gate;
      });
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await until(
        () => parked,
        (n) => n === 1,
      );
      await r.wallet.vault.lock();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(r.engine.backup.getState().status).toBe("locked");
      expect(r.files).toStrictEqual(before); // the pending upload never landed
    } finally {
      await r.close();
    }
  });

  it("cloud write failure → error; sync() recovers", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      r.faults.write = true;
      await r.wallet.backup.enable({ verify: PW, factors: [BPW] });
      await settle(r);
      expect(r.engine.backup.getState().status).toBe("error");
      r.faults.write = false;
      await r.engine.backup.sync();
      expect(r.engine.backup.getState().status).toBe("synced");
    } finally {
      await r.close();
    }
  });

  it("read-back mismatch → error", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const files2 = new Map<string, string>();
      const wallet2 = await createNodeWallet({
        verifyEvent,
        passkey: PASSKEY_CONFIG,
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: KERNEL_URL,
      });
      const inner2 = createMemoryCloudStore(files2);
      const corruptRead = corruptFirstRead(inner2);
      const engine2 = createWalletEngine({
        publicStore: createMemoryPublicStore(),
        verifyEvent,
        weblnAlias: "test",
        lightningMaxFee: () => 0,
        wallet: wallet2,
        sparkNetwork: "regtest",
        fetch: async () => Promise.reject(new Error("offline")),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: LOGGER,
        showCallsStatus: () => undefined,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        cloud: corruptRead,
      });
      try {
        await vaultWithMnemonic(wallet2);
        await engine2.backup.sync();
        // The read-back mismatch surfaces as `error`; the persisted pending marker lets the
        // next pass confirm the landed write instead of conflicting with it.
        const seen: string[] = [];
        const un = engine2.backup.store.subscribe((s) => {
          seen.push(s.status);
        });
        await engine2.backup.enable({ verify: PW, factors: [BPW] }).catch(() => undefined);
        un();
        expect(seen).toContain("error");
      } finally {
        engine2.unsubscribe();
        await wallet2.destroy();
      }
    } finally {
      await r.close();
    }
  });

  it("a lagged read-back confirms the landed write on the next pass — no self-conflict", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const update = vi.spyOn(r.wallet.backup, "update");
      const writesBefore = r.faults.writeCalls;

      const seen: string[] = [];
      const un = r.engine.backup.store.subscribe((s) => {
        seen.push(s.status);
      });
      // Coverage change → upload; the read-back lags and serves the pre-write file once.
      r.faults.lagRead = true;
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      un();

      // The error pass visited; the pending name then confirmed our own landed write —
      // converging to synced without another backup.update or cloud write.
      expect(seen).toContain("error");
      expect(r.engine.backup.getState().status).toBe("synced");
      expect(update).toHaveBeenCalledTimes(1);
      expect(r.faults.writeCalls).toBe(writesBefore + 1);
    } finally {
      await r.close();
    }
  });

  it("a write that lands then throws is confirmed on the next pass", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });

      const seen: string[] = [];
      const un = r.engine.backup.store.subscribe((s) => {
        seen.push(s.status);
      });
      r.faults.landThenThrow = true;
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      un();

      // The timed-out write actually landed: pending confirms it and the pass converges to
      // synced instead of declaring a conflict with itself.
      expect(seen).toContain("error");
      expect(r.engine.backup.getState().status).toBe("synced");
      const listed = await r.engine.backup.list();
      expect(listed[0]?.header.wallets).toHaveLength(2);
    } finally {
      await r.close();
    }
  });

  it("a foreign version plus an unconfirmed pending still reports conflict", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });

      // Capture a same-lineage version this device no longer holds, to replay as foreign.
      const foreign = await r.wallet.wallets.importMnemonic({
        mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
      });
      await settle(r);
      const foreignName = remoteName(r.files);
      const foreignText = r.files.get(foreignName)!;
      await r.wallet.wallets.delete(foreign.walletId, PW);
      await settle(r);

      // Hold the next upload unconfirmed: the write never lands.
      r.faults.write = true;
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      expect(r.engine.backup.getState().status).toBe("error");
      r.faults.write = false;

      // The foreign version shows up while our pending upload is still unconfirmed.
      r.files.set(foreignName, foreignText);
      await r.engine.backup.sync();
      expect(r.engine.backup.getState().status).toBe("conflict");
      expect(r.files.has(foreignName)).toBe(true);
    } finally {
      await r.close();
    }
  });

  it("a write that never landed is retried as a normal upload — no conflict", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);

      r.faults.write = true;
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      expect(r.engine.backup.getState().status).toBe("error");
      expect(r.files.has(name)).toBe(true);

      // The pending file never landed: the pass falls through to the ordinary upload path —
      // a new versioned name, no conflict.
      r.faults.write = false;
      await r.engine.backup.sync();
      expect(r.engine.backup.getState().status).toBe("synced");
      expect(remoteName(r.files)).not.toBe(name);
      expect(r.files.has(name)).toBe(false);
    } finally {
      await r.close();
    }
  });

  it("a rotated backup key whose first upload's read-back lagged is confirmed next pass", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const first = remoteName(r.files);
      const update = vi.spyOn(r.wallet.backup, "update");
      const writesBefore = r.faults.writeCalls;

      const seen: string[] = [];
      const un = r.engine.backup.store.subscribe((s) => {
        seen.push(s.status);
      });
      // The new backup key uploads under a NEW id while the stored record still carries the
      // old one; the read-back lags and serves the pre-write (absent) file once.
      r.faults.lagRead = true;
      await r.engine.backup.enable({ verify: PW, factors: [BPW] }).catch(() => undefined);
      await settle(r);
      un();

      // The error pass visited; pending is bound to the new backup id, so the landed write
      // confirms on the next pass — no conflict, no second update or cloud write, and the
      // superseded old-id file is gone.
      expect(seen).toContain("error");
      expect(r.engine.backup.getState().status).toBe("synced");
      expect(seen).not.toContain("conflict");
      expect(update).toHaveBeenCalledTimes(1);
      expect(r.faults.writeCalls).toBe(writesBefore + 1);
      expect(remoteName(r.files)).not.toBe(first);
      expect(r.files.has(first)).toBe(false);
    } finally {
      await r.close();
    }
  });

  it("a stored record with a malformed pending marker reads as absent", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);
      const text = r.files.get(name)!;
      const stage = async (pending: unknown): Promise<void> =>
        persistentEngineStore(r.storeBacking)
          .collection("backup")
          .put(
            "state",
            new TextEncoder().encode(
              JSON.stringify({
                head: {
                  name,
                  coverage: { walletIds: [], keyIds: [] },
                },
                uploadedAt: 1,
                superseded: [],
                pending,
              }),
            ),
          );
      // A pending name that is not a versioned file drops the whole record → the head is lost
      // and the device re-uploads; the existing file reads as foreign but covered → synced.
      await stage({ name: "not-a-versioned-name", coverage: { walletIds: [], keyIds: [] } });
      await r.engine.backup.sync();
      expect(r.engine.backup.getState().status).toBe("synced");
      const listed = await r.engine.backup.list();
      expect(listed).toHaveLength(2); // the old file stays — foreign versions are never deleted
      expect(r.files.has(name)).toBe(true);
      // Same for a superseded entry that is not a versioned name.
      await persistentEngineStore(r.storeBacking)
        .collection("backup")
        .put(
          "state",
          new TextEncoder().encode(
            JSON.stringify({
              head: { name, coverage: { walletIds: ["w"], keyIds: [] } },
              superseded: ["not-a-versioned-name"],
            }),
          ),
        );
      await r.engine.backup.sync();
      expect(r.engine.backup.getState().status).toBe("synced");
      expect(r.files.get(name)).toBe(text);
    } finally {
      await r.close();
    }
  });

  it("a trigger arriving during a stale in-flight run still runs after unlock", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });

      // Park the reconcile inside the cloud write, then lock + unlock while it is in flight:
      // the post-unlock trigger must still earn a pass under the new generation.
      let release!: () => void;
      r.faults.stall = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await until(
        () => r.faults.stallCalls,
        (n) => n === 1,
      );
      await r.wallet.vault.lock();
      await r.wallet.vault.unlock(PW);
      // Give the post-unlock transition its trigger while the stale run is still parked.
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();

      await until(() => r.engine.backup.getState().status, isSettled);
      expect(r.engine.backup.getState().status).toBe("synced");
      const listed = await r.engine.backup.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.header.wallets).toHaveLength(2);
    } finally {
      await r.close();
    }
  });

  it.each(["password1234", "qwertyuiopas", "Summer2026!!!"])(
    "enable refuses the guessable backup password %s before any kernel call",
    async (password) => {
      const r = await rig();
      try {
        await vaultWithMnemonic(r.wallet);
        await expect(
          r.engine.backup.enable({ verify: PW, factors: [{ kind: "password", password }] }),
        ).rejects.toMatchObject({ name: "BackupControllerError", category: "weak-password" });
        expect(r.wallet.getSnapshot().backup).toBeNull();
        expect(r.files.size).toBe(0);
      } finally {
        await r.close();
      }
    },
  );

  it("scores a passphrase above a common password", async () => {
    await expect(backupPasswordStrength("password1234")).resolves.toMatchObject({
      acceptable: false,
    });
    await expect(backupPasswordStrength(BACKUP_PASSWORD)).resolves.toStrictEqual({
      score: 4,
      acceptable: true,
    });
  });

  it("enable rejects unavailable before any kernel call and enables nothing", async () => {
    const r = await rig({ cloud: false });
    try {
      await vaultWithMnemonic(r.wallet);
      let caught: unknown;
      try {
        await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupControllerError);
      expect((caught as BackupControllerError).category).toBe("unavailable");
      expect(r.wallet.getSnapshot().backup).toBeNull();
    } finally {
      await r.close();
    }
  });

  it("enable maps a typed cloud pre-check failure to its category", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      r.faults.list = new CloudStoreError("quota", "drive is full");
      await expect(r.engine.backup.enable({ verify: PW, factors: [BPW] })).rejects.toMatchObject({
        name: "BackupControllerError",
        category: "quota",
      });
      expect(r.wallet.getSnapshot().backup).toBeNull();
      r.faults.list = new CloudStoreError("unavailable", "offline");
      await expect(r.engine.backup.enable({ verify: PW, factors: [BPW] })).rejects.toMatchObject({
        name: "BackupControllerError",
        category: "unavailable",
      });
      r.faults.list = new CloudStoreError("auth-required", "consent needed");
      await expect(r.engine.backup.enable({ verify: PW, factors: [BPW] })).rejects.toMatchObject({
        name: "BackupControllerError",
        category: "auth-required",
      });
      r.faults.list = undefined;
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      expect(r.engine.backup.getState().status).toBe("synced");
    } finally {
      await r.close();
    }
  });
});

describe("engine lock/unlock", () => {
  it("watch accounts survive lock and unlock", async () => {
    const r = await rig({ cloud: false });
    try {
      await vaultWithMnemonic(r.wallet);
      await until(
        () => r.engine.backup.getState().status,
        (s) => s !== "locked",
      );
      await r.engine.watch.add({
        family: "evm",
        address: "0x00000000000000000000000000000000DeaDBeef",
        name: "cold",
      });
      await r.wallet.vault.lock();
      await until(
        () => r.engine.watch.list().length,
        (n) => n === 0,
      );
      await r.wallet.vault.unlock(PW);
      const [account] = await until(
        () => r.engine.watch.list(),
        (list) => list.length === 1,
      );
      expect(account?.name).toBe("cold");
    } finally {
      await r.close();
    }
  });
});
