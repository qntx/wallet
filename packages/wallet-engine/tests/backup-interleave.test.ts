// oxlint-disable vitest/no-conditional-in-test -- property oracles are inherently conditional
import * as fc from "fast-check";
import { describe, expect, it, vi } from "vite-plus/test";

/**
 * Two BackupControllers — two "devices" sharing one backup id — over one memory cloud whose every
 * op parks until the test releases it: deterministic op-level interleavings here, random ones under
 * fast-check.
 *
 * Each device's wallet is a scripted double: same-lineage devices need a shared BEK, and on a
 * software host the kernel deliberately never retains one through restore (only a kernel passkey
 * ceremony may adopt it — the PRF of a host ceremony crosses the wire). The double models what a
 * native device is after that ceremony: a snapshot carrying the backup id, `update()` minting a
 * structurally valid envelope whose header covers the snapshot, and `restore()` merging an
 * envelope's header coverage the way the kernel merge does. Everything the controller verifies —
 * name digest, header coverage, its own record — is exercised for real.
 */
import type {
  BackupInfo,
  FactorInfo,
  HardwareWalletInfo,
  KeyInfo,
  NostrKeyInfo,
  VaultWalletInfo,
  Wallet,
  WalletInfo,
} from "@qntx/wallet";
import { parseBackupHeader } from "@qntx/wallet";

import { BackupController } from "../src/backup/controller.ts";
import { createMemoryCloudStore } from "../src/backup/memory.ts";
import type { CloudStore } from "../src/backup/port.ts";
import type { EngineLogger } from "../src/events.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

/** The shared backup id — one BEK lineage, 32 lowercase hex like the kernel's HKDF output. */
const BACKUP_ID = "ab".repeat(16);
const LOGGER: EngineLogger = { warn: () => {} };

/** The mutable innards a scripted `getSnapshot` reports — the test edits them as device events. */
type FakeVault = {
  vault: "unlocked";
  lockReason: undefined;
  verifying: false;
  appLock: false;
  verification: "available";
  factors: FactorInfo[];
  wallets: WalletInfo[];
  nostr: { keys: NostrKeyInfo[] };
  importedKeys: KeyInfo[];
  backup: BackupInfo | null;
  blindSigning: false;
};

/** A structurally valid envelope whose header covers `state` — everything the controller parses. */
function fabricateEnvelope(state: FakeVault, createdAt: number): string {
  const header = JSON.stringify({
    // Only entropy records serialise — the kernel can never emit a hardware wallet here.
    wallets: state.wallets
      .filter((w): w is VaultWalletInfo => w.custody === "vault")
      .map((w) => ({
        walletId: w.walletId,
        origin: w.origin,
        words: w.words,
        ...(w.passphrase ? { passphrase: true } : {}),
      })),
    keys: state.importedKeys.map((k) => ({ keyId: k.keyId, family: k.family })),
  });
  return JSON.stringify({
    version: 3,
    createdAt,
    header,
    factors: [
      {
        kind: "password",
        kdf: "argon2id",
        memoryKiB: 65_536,
        passes: 3,
        lanes: 4,
        salt: "c2FsdA",
        sealedBek: "c2VhbGVkLWJlaw",
      },
    ],
    payload: "cGF5bG9hZA",
  });
}

/**
 * The scripted Wallet behind one device. `backup.restore` models the kernel merge — unknown wallet
 * ids join the vault, passphrase-flagged ones wait in `passphraseRequired` — and a vault without a
 * backup key retains the unwrapped one, as a kernel passkey ceremony does on native.
 */
function fakeWallet(state: FakeVault, bekId: string): Wallet {
  const unimplemented = (what: string) => async (): Promise<never> =>
    Promise.reject(new Error(`${what} is not implemented on a scripted wallet`));
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    vault: {
      unlock: unimplemented("vault.unlock"),
      lock: unimplemented("vault.lock"),
      addFactor: unimplemented("vault.addFactor"),
      removeFactor: unimplemented("vault.removeFactor"),
      enrolVerification: unimplemented("vault.enrolVerification"),
      setAppLock: unimplemented("vault.setAppLock"),
      setBlindSigning: unimplemented("vault.setBlindSigning"),
      reset: unimplemented("vault.reset"),
    },
    wallets: {
      createWithPasskey: unimplemented("wallets.createWithPasskey"),
      restoreWithPasskey: unimplemented("wallets.restoreWithPasskey"),
      createMnemonic: unimplemented("wallets.createMnemonic"),
      importMnemonic: unimplemented("wallets.importMnemonic"),
      exportMnemonic: unimplemented("wallets.exportMnemonic"),
      delete: unimplemented("wallets.delete"),
    },
    keys: {
      import: unimplemented("keys.import"),
      list: unimplemented("keys.list"),
      remove: unimplemented("keys.remove"),
      export: unimplemented("keys.export"),
    },
    dataKeys: { get: unimplemented("dataKeys.get") },
    destroy: async () => Promise.resolve(),
    backup: {
      enable: async () => {
        state.backup = { id: bekId, factors: ["passkey"], createdAt: 1 };
        return Promise.resolve();
      },
      update: async () => Promise.resolve(fabricateEnvelope(state, 1)),
      disable: async () => {
        state.backup = null;
        return Promise.resolve();
      },
      restore: async ({ envelope, passphrases }) => {
        const header = parseBackupHeader(envelope);
        const given = new Set((passphrases ?? []).map((p) => p.walletId));
        const held = new Set(state.wallets.map((w) => w.walletId));
        const restored: VaultWalletInfo[] = [];
        const passphraseRequired: string[] = [];
        for (const w of header.wallets) {
          if (held.has(w.walletId)) {
            continue;
          }
          if (w.passphrase === true && !given.has(w.walletId)) {
            passphraseRequired.push(w.walletId);
            continue;
          }
          const info: VaultWalletInfo = {
            walletId: w.walletId,
            custody: "vault",
            origin: w.origin,
            words: w.words,
            backup: w.origin,
            passphrase: w.passphrase ?? false,
            createdAt: 1,
          };
          state.wallets.push(info);
          restored.push(info);
        }
        const heldKeys = new Set(state.importedKeys.map((k) => k.keyId));
        for (const k of header.keys) {
          if (!heldKeys.has(k.keyId)) {
            state.importedKeys.push({ ...k, address: "0x0000", createdAt: 1 });
          }
        }
        // The unwrapped BEK is retained when the vault holds none — the native ceremony's rule.
        state.backup ??= { id: bekId, factors: ["passkey"], createdAt: 1 };
        return Promise.resolve({ wallets: restored, passphraseRequired });
      },
    },
  };
}

type Task = { readonly label: string; readonly run: () => Promise<void> };

/** Parks every op of a wrapped CloudStore; the test releases them one at a time, in any order. */
class Scheduler {
  private readonly queue: Task[] = [];
  private readonly wakeups: Array<() => void> = [];
  private readonly counts = new Map<string, number>();

  wrap(store: CloudStore, tag: string): CloudStore {
    return {
      list: async () => this.schedule(`${tag}:list`, async () => store.list()),
      read: async (name) => this.schedule(`${tag}:read`, async () => store.read(name)),
      write: async (name, text) =>
        this.schedule(`${tag}:write`, async () => store.write(name, text)),
      delete: async (name) => this.schedule(`${tag}:delete`, async () => store.delete(name)),
    };
  }

  get pending(): ReadonlyArray<string> {
    return this.queue.map((t) => t.label);
  }

  calls(prefix: string): number {
    return this.counts.get(prefix) ?? 0;
  }

  private async schedule<T>(label: string, op: () => Promise<T>): Promise<T> {
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        run: async () => {
          try {
            resolve(await op());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      for (const wake of this.wakeups.splice(0)) {
        wake();
      }
    });
  }

  /** Releases the oldest queued task, or the one at `index`. */
  async step(index = 0): Promise<void> {
    const [task] = this.queue.splice(index, 1);
    if (task === undefined) {
      throw new Error(`step() on an empty queue — pending: ${this.pending.join(",")}`);
    }
    await task.run();
  }

  /** Releases the first queued task whose label contains `part`, waiting for it to arrive. */
  async stepLabel(part: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    let index = this.queue.findIndex((t) => t.label.includes(part));
    while (index === -1) {
      if (Date.now() > deadline) {
        throw new Error(`no queued task matching ${part} — pending: ${this.pending.join(",")}`);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- waiting is the point
      await new Promise<void>((resolve) => {
        this.wakeups.push(resolve);
        setTimeout(resolve, 5);
      });
      index = this.queue.findIndex((t) => t.label.includes(part));
    }
    await this.step(index);
  }

  async untilQueued(n: number, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.queue.length < n) {
      if (Date.now() > deadline) {
        throw new Error(`untilQueued(${n}) timed out — pending: ${this.pending.join(",")}`);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- waiting is the point
      await new Promise<void>((resolve) => {
        this.wakeups.push(resolve);
        setTimeout(resolve, 5);
      });
    }
  }

  /** Drives the queue while `promises` are unsettled; `pick` chooses which parked op runs next. */
  async drive(
    promises: ReadonlyArray<Promise<unknown>>,
    pick?: (queueLength: number) => number,
    ms = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + ms;
    const pending = new Set(promises);
    for (const p of promises) {
      void p.then(
        () => pending.delete(p),
        () => pending.delete(p),
      );
    }
    while (pending.size > 0) {
      if (Date.now() > deadline) {
        throw new Error(`drive() timed out — pending: ${this.pending.join(",")}`);
      }
      if (this.queue.length === 0) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- waiting is the point
        await new Promise<void>((resolve) => {
          this.wakeups.push(resolve);
          setTimeout(resolve, 1);
        });
        continue;
      }
      const index = pick === undefined ? 0 : Math.abs(pick(this.queue.length)) % this.queue.length;
      // oxlint-disable-next-line eslint/no-await-in-loop -- ops release one at a time on purpose
      await this.step(index);
    }
    await Promise.all(promises);
  }
}

type Device = {
  readonly tag: "A" | "B" | "C";
  readonly state: FakeVault;
  readonly backup: BackupController;
};

/** A device already holding the lineage BEK (`backup` set), or a fresh vault (`null`). */
function device(tag: Device["tag"], cloud: CloudStore, options?: { fresh?: boolean }): Device {
  const state: FakeVault = {
    vault: "unlocked",
    lockReason: undefined,
    verifying: false,
    appLock: false,
    verification: "available",
    factors: [],
    wallets: [],
    nostr: { keys: [] },
    importedKeys: [],
    backup: options?.fresh === true ? null : { id: BACKUP_ID, factors: ["passkey"], createdAt: 1 },
    blindSigning: false,
  };
  const backup = new BackupController({
    wallet: fakeWallet(state, BACKUP_ID),
    cloud,
    now: () => Date.now(),
    logger: LOGGER,
  });
  backup.setStore(createMemoryEngineStore());
  return { tag, state, backup };
}

function addWallet(d: Device, walletId: string, options?: { passphrase?: boolean }): void {
  d.state.wallets.push({
    walletId,
    custody: "vault",
    origin: "mnemonic",
    words: 12,
    backup: "mnemonic",
    passphrase: options?.passphrase ?? false,
    createdAt: 1,
  });
}

function addKey(d: Device, keyId: string): void {
  d.state.importedKeys.push({ keyId, family: "evm", address: "0x0000", createdAt: 1 });
}

function addHardwareWallet(d: Device, walletId: string): void {
  const info: HardwareWalletInfo = {
    walletId,
    custody: "hardware",
    device: "keystone",
    fingerprint: "0123abcd",
    createdAt: 1,
  };
  d.state.wallets.push(info);
}

function singleFile(files: Map<string, string>): string {
  if (files.size !== 1) {
    throw new Error(`expected exactly one cloud file, got ${[...files.keys()].join(",")}`);
  }
  return [...files.keys()][0]!;
}

type CloudFile = { readonly name: string; readonly wallets: string[]; readonly keys: string[] };

function cloudFiles(files: Map<string, string>): ReadonlyArray<CloudFile> {
  return [...files.entries()].map(([name, text]) => {
    const header = parseBackupHeader(text);
    return {
      name,
      wallets: header.wallets.map((w) => w.walletId),
      keys: header.keys.map((k) => k.keyId),
    };
  });
}

function deviceCoverage(d: Device): { wallets: Set<string>; keys: Set<string> } {
  return {
    wallets: new Set(d.state.wallets.filter((w) => w.custody === "vault").map((w) => w.walletId)),
    keys: new Set(d.state.importedKeys.map((k) => k.keyId)),
  };
}

function unionCoverage(files: ReadonlyArray<CloudFile>): {
  wallets: Set<string>;
  keys: Set<string>;
} {
  const wallets = new Set<string>();
  const keys = new Set<string>();
  for (const f of files) {
    for (const w of f.wallets) {
      wallets.add(w);
    }
    for (const k of f.keys) {
      keys.add(k);
    }
  }
  return { wallets, keys };
}

function isSubset<T>(a: Set<T>, b: Set<T>): boolean {
  return [...a].every((v) => b.has(v));
}

function sameSet<T>(a: ReadonlyArray<T>, b: Set<T>): boolean {
  return a.length === b.size && isSubset(new Set(a), b);
}

/** The cloud file whose header coverage equals the device's local coverage, if any. */
function fileCovering(files: Map<string, string>, d: Device): CloudFile | undefined {
  const cov = deviceCoverage(d);
  return cloudFiles(files).find(
    (f) => sameSet(f.wallets, cov.wallets) && sameSet(f.keys, cov.keys),
  );
}

vi.setConfig({ testTimeout: 30_000 });

describe("two devices, one shared cloud", () => {
  it("diverged devices converge to one union version through merge-restores", async () => {
    const files = new Map<string, string>();
    const inner = createMemoryCloudStore(files);
    const sched = new Scheduler();
    const a = device("A", sched.wrap(inner, "A"));
    const b = device("B", sched.wrap(inner, "B"), { fresh: true });

    addWallet(a, "w-a");
    await sched.drive([a.backup.sync()]);
    const a0 = singleFile(files);

    // Fresh-vault restore: B unwraps and keeps A's BEK, so the same id is already B's.
    await sched.drive([b.backup.restore({ name: a0, backupFactor: { kind: "passkey" } })]);
    expect(b.backup.getState().status).toBe("synced");
    expect(sched.calls("B:write")).toBe(0); // adopted, no upload

    // Each device diverges: A adds one wallet, B another.
    addWallet(a, "w-a2");
    addWallet(b, "w-b");

    // Both list before either writes — neither pass can see the other's version.
    const pa = a.backup.sync();
    const pb = b.backup.sync();
    await sched.untilQueued(2);
    await sched.stepLabel("list");
    await sched.stepLabel("list");
    await sched.drive([pa, pb]);
    expect(files.size).toBe(2); // A's new version and B's new version, side by side
    const union1 = unionCoverage(cloudFiles(files));
    expect(isSubset(deviceCoverage(a).wallets, union1.wallets)).toBe(true);
    expect(isSubset(deviceCoverage(b).wallets, union1.wallets)).toBe(true);

    // Each reports conflict once a later pass notices the foreign version.
    await sched.drive([a.backup.sync(), b.backup.sync()]);
    expect(a.backup.getState().status).toBe("conflict");
    expect(b.backup.getState().status).toBe("conflict");

    // A merge-restores B's file → rule 3: superseded after the union upload — which also
    // deletes A's own previous version. Exactly one file, covering all three wallets.
    const bFile = fileCovering(files, b)!.name;
    await sched.drive([a.backup.restore({ name: bFile, backupFactor: { kind: "passkey" } })]);
    await sched.drive([a.backup.sync()]);
    const unionFile = singleFile(files);
    const unionHeader = parseBackupHeader(files.get(unionFile)!);
    expect(unionHeader.wallets).toHaveLength(3);
    expect(a.backup.getState().status).toBe("synced");

    // B merge-restores A's union → C_R = C_L: adopted as head without any upload, and B's own
    // superseded version is deleted. One file remains; both devices are synced.
    const bWritesBefore = sched.calls("B:write");
    await sched.drive([b.backup.restore({ name: unionFile, backupFactor: { kind: "passkey" } })]);
    await sched.drive([b.backup.sync()]);
    expect(sched.calls("B:write")).toBe(bWritesBefore);
    expect(singleFile(files)).toBe(unionFile);
    expect(a.backup.getState().status).toBe("synced");
    expect(b.backup.getState().status).toBe("synced");
  });

  it("a superseded delete racing the other device's write never touches that version", async () => {
    const files = new Map<string, string>();
    const inner = createMemoryCloudStore(files);
    const sched = new Scheduler();
    const a = device("A", sched.wrap(inner, "A"));
    const b = device("B", sched.wrap(inner, "B"));

    addWallet(a, "w-a");
    await sched.drive([a.backup.sync()]);
    // A changes coverage so it holds a superseded file to delete mid-pass.
    addWallet(a, "w-a2");
    const aOld = singleFile(files);
    addWallet(b, "w-b");

    const pa = a.backup.sync();
    const pb = b.backup.sync();
    await sched.untilQueued(2);
    await sched.stepLabel("A:list");
    await sched.stepLabel("B:list");
    await sched.stepLabel("A:write");
    await sched.stepLabel("A:read");
    // A:delete(aOld) is parked next to B's in-flight write — release the delete first.
    await sched.stepLabel("A:delete");
    expect(files.has(aOld)).toBe(false);
    await sched.drive([pa, pb]);

    // B's version landed whole and survives — the delete only ever named A's superseded file.
    const bVersion = fileCovering(files, b);
    expect(bVersion).toBeDefined();
    expect(files.has(bVersion!.name)).toBe(true);
  });

  it("a lagging list hides a foreign version for one pass — never deleted, conflict later", async () => {
    const files = new Map<string, string>();
    const inner = createMemoryCloudStore(files);
    const sched = new Scheduler();
    // A's store drops a name from exactly one list response.
    const lagOnce = new Set<string>();
    const laggy: CloudStore = {
      list: async () => {
        const names = await inner.list();
        return names.filter((n) => !lagOnce.delete(n));
      },
      read: async (n) => inner.read(n),
      write: async (n, t) => inner.write(n, t),
      delete: async (n) => inner.delete(n),
    };
    const a = device("A", sched.wrap(laggy, "A"));
    const b = device("B", sched.wrap(inner, "B"));

    addWallet(a, "w-a");
    await sched.drive([a.backup.sync()]);
    addWallet(b, "w-a");
    addWallet(b, "w-b");
    await sched.drive([b.backup.sync()]);
    const bFile = fileCovering(files, b)!.name;

    // A's next list omits B's fresh version: A syncs clean, sees nothing foreign.
    lagOnce.add(bFile);
    await sched.drive([a.backup.sync()]);
    expect(a.backup.getState().status).toBe("synced");
    expect(files.has(bFile)).toBe(true); // foreign versions are never deleted anyway

    // The next, complete list surfaces it as a conflict.
    await sched.drive([a.backup.sync()]);
    expect(a.backup.getState().status).toBe("conflict");
    expect(files.has(bFile)).toBe(true);
  });

  it("a provider rollback to an older own version re-uploads without losing coverage", async () => {
    const files = new Map<string, string>();
    const inner = createMemoryCloudStore(files);
    const sched = new Scheduler();
    const a = device("A", sched.wrap(inner, "A"));

    addWallet(a, "w-a");
    await sched.drive([a.backup.sync()]);
    const a0 = singleFile(files);
    const a0Text = files.get(a0)!;
    addWallet(a, "w-a2");
    await sched.drive([a.backup.sync()]);
    const a1 = singleFile(files);
    expect(a1).not.toBe(a0);

    // Roll the namespace back: the head file is gone, the older own version is back.
    files.delete(a1);
    files.set(a0, a0Text);
    await sched.drive([a.backup.sync()]);
    expect(a.backup.getState().status).toBe("synced");
    // Re-uploaded: the cloud again covers everything the device holds.
    const union = unionCoverage(cloudFiles(files));
    const cov = deviceCoverage(a);
    expect(isSubset(cov.wallets, union.wallets)).toBe(true);
    expect(isSubset(cov.keys, union.keys)).toBe(true);
    // The rolled-back older version is foreign-but-covered: it stays, untouched.
    expect(files.has(a0)).toBe(true);
    expect(files.size).toBe(2);
  });

  it("a fresh-vault restore skipping a passphrase wallet stays conflict and uploads anyway", async () => {
    const files = new Map<string, string>();
    const inner = createMemoryCloudStore(files);
    const sched = new Scheduler();
    const a = device("A", sched.wrap(inner, "A"));
    const c = device("C", sched.wrap(inner, "C"), { fresh: true });

    addWallet(a, "w-a");
    addWallet(a, "w-pass", { passphrase: true });
    await sched.drive([a.backup.sync()]);
    const aFile = singleFile(files);

    // C restores without passphrases: the flagged wallet is skipped, so the file's coverage is
    // not contained in C's — it stays foreign, undeleted, and C still uploads its own.
    let restored: Awaited<ReturnType<BackupController["restore"]>> | undefined;
    await sched.drive([
      c.backup.restore({ name: aFile, backupFactor: { kind: "passkey" } }).then((r) => {
        restored = r;
        return r;
      }),
    ]);
    expect(restored?.passphraseRequired).toStrictEqual(["w-pass"]);
    expect(restored?.wallets.map((w) => w.walletId)).toStrictEqual(["w-a"]);
    await sched.drive([c.backup.sync()]);
    expect(c.backup.getState().status).toBe("conflict");
    expect(files.has(aFile)).toBe(true);
    expect(files.size).toBe(2); // A's file + C's own version
  });

  it("importing a single private key uploads a version whose header carries it", async () => {
    const files = new Map<string, string>();
    const inner = createMemoryCloudStore(files);
    const sched = new Scheduler();
    const a = device("A", sched.wrap(inner, "A"));

    addWallet(a, "w-a");
    addKey(a, "aa".repeat(8));
    await sched.drive([a.backup.sync()]);
    expect(a.backup.getState().status).toBe("synced");
    const name = singleFile(files);
    const header = parseBackupHeader(files.get(name)!);
    expect(header.keys.map((k) => k.keyId)).toStrictEqual(["aa".repeat(8)]);
  });

  it("a hardware wallet stays out of coverage, unprotected, uploads and conflicts", async () => {
    const files = new Map<string, string>();
    const inner = createMemoryCloudStore(files);
    const sched = new Scheduler();
    const a = device("A", sched.wrap(inner, "A"));
    const b = device("B", sched.wrap(inner, "B"), { fresh: true });

    // A pairs a hardware wallet next to its seed wallet; the cloud may only see the seed one.
    addWallet(a, "w-a");
    addHardwareWallet(a, "hw-a");

    await sched.drive([a.backup.sync()]);
    const a0 = singleFile(files);
    expect(cloudFiles(files)).toStrictEqual([{ name: a0, wallets: ["w-a"], keys: [] }]);
    // A hardware wallet holds no seed material, so it can never wait for a backup.
    expect(a.backup.getState().unprotected.walletIds).toStrictEqual([]);

    // The next pass confirms the head instead of re-uploading: coverage matches without hw-a.
    await sched.drive([a.backup.sync()]);
    expect(files.size).toBe(1);
    expect(a.backup.getState().status).toBe("synced");

    // B adopts the version, adds its own seed wallet and uploads the union. A merge-restores:
    // its coverage becomes the union and it adopts B's head — synced, not conflict, because no
    // file is ever expected to cover the hardware wallet.
    await sched.drive([b.backup.restore({ name: a0, backupFactor: { kind: "passkey" } })]);
    addWallet(b, "w-b");
    await sched.drive([b.backup.sync()]);
    const union = singleFile(files);
    await sched.drive([a.backup.restore({ name: union, backupFactor: { kind: "passkey" } })]);
    await sched.drive([a.backup.sync(), b.backup.sync()]);
    expect(a.backup.getState().status).toBe("synced");
    expect(b.backup.getState().status).toBe("synced");
    expect(files.size).toBe(1);
    // The adopted head covers A's seed wallets, so A wrote exactly its first upload — a
    // coverage leak (the hardware wallet counted) would re-upload a version no file can match.
    expect(sched.calls("A:write")).toBe(1);
    expect(unionCoverage(cloudFiles(files)).wallets).toStrictEqual(new Set(["w-a", "w-b"]));
  });

  it("random op-level interleavings preserve the union and synced invariants", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            aWallet: fc.integer({ min: 0, max: 6 }),
            bWallet: fc.integer({ min: 0, max: 6 }),
            aKey: fc.integer({ min: -1, max: 3 }),
            bKey: fc.integer({ min: -1, max: 3 }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 400, maxLength: 400 }),
        async (rounds, picks) => {
          const files = new Map<string, string>();
          const inner = createMemoryCloudStore(files);
          const sched = new Scheduler();
          const a = device("A", sched.wrap(inner, "A"));
          const b = device("B", sched.wrap(inner, "B"), { fresh: true });
          addWallet(a, "w-a");
          await sched.drive([a.backup.sync()]);
          await sched.drive([
            b.backup.restore({ name: singleFile(files), backupFactor: { kind: "passkey" } }),
          ]);
          const used = new Map<string, Set<string>>([
            ["A", new Set<string>(["w-a"])],
            ["B", new Set<string>()],
          ]);
          let pickIndex = 0;
          const pick = (n: number) => picks[pickIndex++ % picks.length]! % n;
          for (const round of rounds) {
            for (const [d, wi, ki] of [
              [a, round.aWallet, round.aKey],
              [b, round.bWallet, round.bKey],
            ] as const) {
              const seen = used.get(d.tag)!;
              const walletId = `w-${wi}`;
              if (!seen.has(walletId)) {
                seen.add(walletId);
                addWallet(d, walletId);
              }
              if (ki >= 0) {
                const keyId = (ki + 1).toString(16).padStart(16, "0");
                if (!seen.has(keyId)) {
                  seen.add(keyId);
                  addKey(d, keyId);
                }
              }
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- each round's syncs must settle before the next
            await sched.drive([a.backup.sync(), b.backup.sync()], pick);
          }
          // One last concurrent pass so nothing is still in flight at assertion time.
          await sched.drive([a.backup.sync(), b.backup.sync()], pick);

          // Quiescence: the union of cloud header coverage contains every device's coverage.
          const union = unionCoverage(cloudFiles(files));
          for (const d of [a, b]) {
            const cov = deviceCoverage(d);
            expect(isSubset(cov.wallets, union.wallets)).toBe(true);
            expect(isSubset(cov.keys, union.keys)).toBe(true);
            // …and a synced device's head is present with coverage equal to its own.
            expect(
              d.backup.getState().status !== "synced" || fileCovering(files, d) !== undefined,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 8 },
    );
  });
});
