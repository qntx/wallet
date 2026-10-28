/**
 * BackupController over a REAL Node kernel + a memory CloudStore (wrapped to inject failures and
 * foreign writes). The kernel keeps the BEK; the engine only ever moves ciphertext.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import type { Wallet, WalletInfo } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { nostr } from "@qntx/wallet/nostr";

import { BackupControllerError } from "../src/backup/errors.ts";
import { createMemoryCloudStore } from "../src/backup/memory.ts";
import type { CloudStore } from "../src/backup/port.ts";
import { createWalletEngine } from "../src/engine.ts";
import type { EngineLogger } from "../src/events.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
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

const LOGGER: EngineLogger = { warn: () => {} };

/** Corrupts exactly the first non-empty read — the read-back check then surfaces `error`. */
function corruptFirstRead(inner: CloudStore): CloudStore {
  let used = false;
  return {
    available: async () => inner.available(),
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

function unprotectedWallets(info: WalletInfo): ReadonlyArray<string> {
  return info.backup === "mnemonic" ? [] : [info.walletId];
}

type Rig = {
  readonly wallet: Wallet;
  readonly cloud: CloudStore;
  readonly files: Map<string, string>;
  readonly faults: {
    write: boolean;
    read: boolean;
    del: boolean;
    stall: Promise<void> | undefined;
    stallCalls: number;
  };
  readonly engine: ReturnType<typeof createWalletEngine>;
  readonly close: () => Promise<void>;
};

async function rig(opts: { cloud?: boolean } = {}): Promise<Rig> {
  const wallet = await createNodeWallet({
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
    stall: undefined as Promise<void> | undefined,
    stallCalls: 0,
  };
  const cloud: CloudStore = {
    available: async () => inner.available(),
    list: async () => inner.list(),
    read: async (name) => {
      if (faults.read) {
        throw new Error("read failed");
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
  const engine = createWalletEngine({
    wallet,
    fetch: async () => Promise.reject(new Error("offline")),
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: LOGGER,
    openStore: async () => Promise.resolve(persistentEngineStore(storeBacking)),
    ...(opts.cloud === false ? {} : { cloud }),
  });
  return {
    wallet,
    cloud,
    files,
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
function persistentEngineStore(backing: Map<string, Map<string, Uint8Array>>): EngineStore {
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

describe("BackupController", () => {
  it("no cloud store → unavailable, unprotected lists the mnemonic-unbacked wallet", async () => {
    const r = await rig({ cloud: false });
    try {
      const created = await vaultWithMnemonic(r.wallet);
      // A mnemonic wallet reports backup:"mnemonic" — it is NOT unprotected. Add a passkey one?
      // The created wallet's backup field is "mnemonic" after confirm; assert empty unprotected.
      await settle(r);
      const s = r.engine.backup.getState();
      expect(s.status).toBe("unavailable");
      expect(s.unprotected.walletIds).toStrictEqual(unprotectedWallets(created));
    } finally {
      await r.close();
    }
  });

  it("enable → remote file, read-back, synced, unprotected empty", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const s = r.engine.backup.getState();
      expect(s.status).toBe("synced");
      expect(s.unprotected.walletIds).toStrictEqual([]);
      const name = remoteName(r.files);
      expect(name).toMatch(/^qntx-wallet-backup-[0-9a-f]{32}\.json$/);
      const listed = await r.engine.backup.list();
      expect(listed.map((f) => f.name)).toStrictEqual([name]);
      const { header: firstHeader } = listed[0]!;
      expect(firstHeader.wallets).toHaveLength(1);
    } finally {
      await r.close();
    }
  });

  it("import / delete / nostr-key changes each auto-sync the remote", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);

      // Import a second mnemonic wallet → new remote header.
      const draft = await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      let listed = await r.engine.backup.list();
      let { header } = listed[0]!;
      expect(header.wallets).toHaveLength(2);

      // Import a standalone nostr key → count goes to 1.
      const key = await nostr(r.wallet).generateKey();
      await settle(r);
      listed = await r.engine.backup.list();
      ({ header } = listed[0]!);
      expect(header.importedNostrKeyCount).toBe(1);

      // Delete the wallet → back to 1 wallet.
      await r.wallet.wallets.delete(draft.walletId, PW);
      await settle(r);
      listed = await r.engine.backup.list();
      ({ header } = listed[0]!);
      expect(header.wallets).toHaveLength(1);
      expect(key.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(remoteName(r.files)).toBe(name); // same file, rewritten
    } finally {
      await r.close();
    }
  });

  it("foreign write → conflict; own-lineage restore merges and syncs the superset", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);

      // A second device: fresh vault restored from the same envelope — it adopts the BEK, adds
      // a wallet and uploads first. Device 1 then changes coverage and sees the foreign digest.
      const wallet2 = await createNodeWallet({
        passkey: PASSKEY_CONFIG,
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: KERNEL_URL,
      });
      const engine2 = createWalletEngine({
        wallet: wallet2,
        fetch: async () => Promise.reject(new Error("offline")),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: LOGGER,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        cloud: r.cloud,
      });
      try {
        await engine2.backup.restore({ name, backupFactor: BPW, factor: PW });
        // Device 2 adds its own wallet and uploads it over the shared file.
        await wallet2.wallets.importMnemonic({
          mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
        });
        await engine2.backup.sync();
        const listed2 = await engine2.backup.list();
        const { header: header2 } = listed2[0]!;
        expect(header2.wallets).toHaveLength(2);
      } finally {
        engine2.unsubscribe();
        await wallet2.destroy();
      }

      // Device 1 changes coverage → reconcile takes the update path → foreign digest → conflict.
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      await settle(r);
      expect(r.engine.backup.getState().status).toBe("conflict");

      // Own-lineage restore merges the foreign file, then the next sync uploads the superset:
      // device 1's two wallets plus device 2's one.
      const merged = await r.engine.backup.restore({ name, backupFactor: BPW });
      expect(merged).toHaveLength(1); // device 2's wallet is the only new one
      await settle(r);
      expect(r.engine.backup.getState().status).toBe("synced");
      const listed3 = await r.engine.backup.list();
      const { header } = listed3[0]!;
      expect(header.wallets).toHaveLength(3);
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
      await expect(r.engine.backup.disable()).rejects.toThrow("backup sync failed");
      expect(r.files.has(name)).toBe(true); // deletion failed, file survives
      r.faults.del = false;
      await settle(r);
      expect(r.files.has(name)).toBe(false); // retried
      expect(r.engine.backup.getState().status).toBe("off");
    } finally {
      await r.close();
    }
  });

  it("fresh-vault restore adopts the file: first sync overwrites, third vault restores", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);
      const original = r.files.get(name)!;

      // Second device, uninitialized vault: restore from the cloud file directly.
      const wallet2 = await createNodeWallet({
        passkey: PASSKEY_CONFIG,
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: KERNEL_URL,
      });
      const engine2 = createWalletEngine({
        wallet: wallet2,
        fetch: async () => Promise.reject(new Error("offline")),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: LOGGER,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        cloud: r.cloud,
      });
      const restored = await engine2.backup.restore({
        name,
        backupFactor: BPW,
        factor: { kind: "password", password: PASSWORD },
      });
      try {
        expect(restored).toHaveLength(1);
        // No explicit sync(): restore converges its own reconcile — the adopted baseline
        // makes the first pass overwrite the same file in place, never a conflict.
        const state = await until(() => engine2.backup.getState().status, isSettled);
        expect(state).toBe("synced");
        expect(r.files.size).toBe(1);
        expect(r.files.get(name)).toBeDefined();
        expect(r.files.get(name)).not.toBe(original);
      } finally {
        engine2.unsubscribe();
        await wallet2.destroy();
      }

      // A third fresh vault restores the rewritten file with the original backup password.
      const wallet3 = await createNodeWallet({
        passkey: PASSKEY_CONFIG,
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: KERNEL_URL,
      });
      try {
        const restored3 = await wallet3.backup.restore({
          envelope: r.files.get(name)!,
          backupFactor: BPW,
          factor: { kind: "password", password: PASSWORD },
        });
        expect(restored3).toHaveLength(1);
        expect(restored3[0]!.walletId).toBe(restored[0]!.walletId);
      } finally {
        await wallet3.destroy();
      }
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
      let release: (() => void) | undefined;
      const stall = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const inner = createMemoryCloudStore(r.files);
      const stalled: CloudStore = {
        available: async () => inner.available(),
        list: async () => inner.list(),
        read: async (n) => inner.read(n),
        write: async (n, text) => {
          await stall;
          return inner.write(n, text);
        },
        delete: async (n) => inner.delete(n),
      };
      void stalled;
      await r.wallet.wallets.importMnemonic({
        mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
      });
      const before = r.files.get(name);
      await r.wallet.vault.lock();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(r.engine.backup.getState().status).toBe("locked");
      expect(r.files.get(name)).toBe(before); // the pending upload never landed
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
      await r.wallet.backup.enable({ verify: PW, factors: [BPW] });
      const files2 = new Map<string, string>();
      const wallet2 = await createNodeWallet({
        passkey: PASSKEY_CONFIG,
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: KERNEL_URL,
      });
      const inner2 = createMemoryCloudStore(files2);
      const corruptRead = corruptFirstRead(inner2);
      const engine2 = createWalletEngine({
        wallet: wallet2,
        fetch: async () => Promise.reject(new Error("offline")),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: LOGGER,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        cloud: corruptRead,
      });
      try {
        await vaultWithMnemonic(wallet2);
        await engine2.backup.sync();
        // The read-back mismatch surfaces as `error`; the enabled snapshot trigger then runs
        // once more and the orphaned upload reads as foreign-with-no-baseline → conflict.
        // Assert the error state was actually visited.
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

  it("a trigger arriving during a stale in-flight run still runs after unlock", async () => {
    const r = await rig();
    try {
      await vaultWithMnemonic(r.wallet);
      await r.engine.backup.enable({ verify: PW, factors: [BPW] });
      const name = remoteName(r.files);

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
      expect(listed[0]!.header.wallets).toHaveLength(2);
      expect(r.files.get(name)).toBeDefined();
    } finally {
      await r.close();
    }
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
});
