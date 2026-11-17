/**
 * HN-02 — two live kernels in one app share one vault file and silently overwrite each other.
 *
 * What it demonstrates: the RN file store (kernel/store.ts createFileStore) applies commits to
 * its own cached `image` and never re-reads the file inside `commit`, so `init` /
 * `expect-revision` preconditions are checked only against that runtime's stale cache. Every
 * KernelHost is its own KernelRuntime — no process singleton — so two simultaneous kernels over
 * one vault.cbor race:
 *   Scenario 1 (vault wipe): two kernels boot on an empty vault; both importMnemonic succeed and
 *   the second `init` silently replaces the first vault on disk — wallet A's record is gone.
 *   Scenario 2 (lost update): B boots with a stale revision cache; A commits, then B commits —
 *   B's `expect-revision` passes against its cache and its write drops A's record from the file.
 *
 * passes = vulnerable (the imports/commits asserted as succeeding are what a safe store must
 * reject — once fixed, these assertions fail).
 */
import { argon2Sync, pbkdf2 as nodePbkdf2 } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import { nobleBackend, verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";

import { startKernel } from "../../../wallet-kernel/src/index.ts";
import type { KernelPlatform, createMemoryStore } from "../../../wallet-kernel/src/index.ts";
import { bindNativeKeystore } from "../../kernel/keystore.ts";
import type { KernelKeystoreNative } from "../../kernel/keystore.ts";
import { createFileStore } from "../../kernel/store.ts";
import { createKernelPort } from "../../kernel/transport.ts";
import type { KernelFramePipe } from "../../kernel/transport.ts";
import type { KernelHostLike, KernelExitReason } from "../../src/host.ts";
import { createNativeWallet } from "../../src/index.ts";

vi.mock("react-native-nitro-modules", () => ({
  NitroModules: { createHybridObject: vi.fn() },
}));

const PASSKEY: PasskeyConfig = {
  rpId: "harness.test",
  rpName: "Harness",
  walletSalt: "wallet",
  vaultSalt: "vault",
  backupSalt: "backup",
};
const AUTOLOCK: AutoLockPolicy = { platform: "native", backgroundSeconds: 60 };

const M1 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const M2 =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

/** __qntx.keystore stand-in — identical semantics to the one in tests/native-wallet.test.ts. */
function fakeNativeKeystore() {
  const keys = new Map<string, Uint8Array>();
  const presence = new Set<string>();
  const failures: string[] = [];
  let lockScreen = true;
  const later = (fn: () => void) => {
    setTimeout(fn);
  };
  const seal = (bytes: Uint8Array) => bytes.toReversed();
  const native: KernelKeystoreNative = {
    locale: "en-US",
    seal: (id, secret, _title, _description, done) => {
      const code = failures.shift() ?? (lockScreen ? undefined : "verification-unavailable");
      const sealed = seal(secret);
      if (code === undefined) {
        keys.set(id, sealed);
        presence.add(id);
      }
      later(() => {
        done(code === undefined ? sealed : undefined, code, undefined);
      });
    },
    open: (id, sealed, _title, _description, done) => {
      const code =
        failures.shift() ?? (!lockScreen || !presence.has(id) ? "factor-invalidated" : undefined);
      const known = keys.get(id);
      later(() => {
        if (code !== undefined) {
          done(undefined, code, undefined);
          return;
        }
        done(known === undefined ? undefined : seal(sealed), undefined, undefined);
      });
    },
    sealDevice: (id, secret, done) => {
      const code = failures.shift();
      const sealed = seal(secret);
      if (code === undefined) {
        keys.set(id, sealed);
      }
      later(() => {
        done(code === undefined ? sealed : undefined, code, undefined);
      });
    },
    openDevice: (id, sealed, done) => {
      const code = failures.shift();
      const known = keys.get(id);
      later(() => {
        if (code !== undefined) {
          done(undefined, code, undefined);
          return;
        }
        done(
          known === undefined ? undefined : seal(sealed),
          known === undefined ? "factor-invalidated" : undefined,
          undefined,
        );
      });
    },
    probe: (id, protection, done) => {
      const alive = keys.has(id) && (protection === "device" || (lockScreen && presence.has(id)));
      later(() => {
        done(undefined, alive ? undefined : "factor-invalidated", undefined);
      });
    },
    remove: (id, done) => {
      keys.delete(id);
      presence.delete(id);
      later(() => {
        done(undefined, undefined, undefined);
      });
    },
    authenticate: (_title, _description, done) => {
      const code = failures.shift() ?? (lockScreen ? undefined : "verification-unavailable");
      later(() => {
        done(undefined, code, undefined);
      });
    },
    clear: (done) => {
      keys.clear();
      presence.clear();
      later(() => {
        done(undefined, undefined, undefined);
      });
    },
  };
  return {
    native,
    failNext: (code: string) => failures.push(code),
    removeLockScreen: () => {
      lockScreen = false;
      for (const id of presence) {
        keys.delete(id);
      }
      presence.clear();
    },
  };
}

/** In-memory frame pipe: host wrapper (MainPort) ↔ kernel-side transport (Port). */
type FakeHost = KernelHostLike & {
  readonly inbound: (f: ArrayBuffer) => void;
  readonly locked: () => boolean;
  readonly backgroundLock: () => number | undefined;
  readonly started: () => number[];
  readonly _integrity: () => void;
  readonly _exit: (reason: KernelExitReason) => void;
};

function makePipe(): { host: FakeHost; pipe: KernelFramePipe } {
  let hostCb: ((f: ArrayBuffer) => void) | undefined;
  let kernelCb: ((f: ArrayBuffer) => void) | undefined;
  let exitCb: ((r: KernelExitReason) => void) | undefined;
  let integCb: (() => void) | undefined;
  let locked = false;
  let backgroundLock: number | undefined;
  const starts: number[] = [];
  const pipe: KernelFramePipe = {
    post: (frame) => {
      if (!locked) {
        hostCb?.(frame);
      }
    },
    onMessage: (cb) => {
      kernelCb = cb;
    },
    onIntegrityViolation: (cb) => {
      integCb = cb;
    },
  };
  const host = {
    start: (seconds: number) => {
      starts.push(seconds);
    },
    post: (frame) => {
      if (!locked) {
        kernelCb?.(frame);
      }
    },
    onMessage: (cb) => {
      hostCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    setBackgroundLock: (seconds: number) => {
      backgroundLock = seconds;
    },
    lock: () => {
      locked = true;
      exitCb?.("locked");
    },
    inbound: (f: ArrayBuffer) => {
      hostCb?.(f);
    },
    locked: () => locked,
    backgroundLock: () => backgroundLock,
    started: () => [...starts],
    _integrity: () => integCb?.(),
    _exit: (reason: KernelExitReason) => exitCb?.(reason),
  } as KernelHostLike & {
    inbound: (f: ArrayBuffer) => void;
    locked: () => boolean;
    backgroundLock: () => number | undefined;
    started: () => number[];
    _integrity: () => void;
    _exit: (reason: KernelExitReason) => void;
  };
  return { host, pipe };
}

function platform(
  store: ReturnType<typeof createMemoryStore>,
  keystore: KernelKeystoreNative,
): KernelPlatform {
  return {
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    keystore: bindNativeKeystore(keystore),
    passkey: undefined,
    now: () => Date.now(),
    elapsed: () => performance.now(),
    setTimer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    argon2id: async (password, salt, cost, length) =>
      Promise.resolve(
        new Uint8Array(
          argon2Sync("argon2id", {
            message: password,
            nonce: salt,
            memory: cost.memoryKiB,
            passes: cost.passes,
            parallelism: cost.lanes,
            tagLength: length,
          }),
        ),
      ),
    pbkdf2: async (hash, password, salt, iterations, length) =>
      new Promise((resolve, reject) => {
        nodePbkdf2(
          password,
          salt,
          iterations,
          length,
          hash === "sha256" ? "sha256" : "sha512",
          (error, key) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(new Uint8Array(key));
          },
        );
      }),
    store,
    policy: {
      maxSessionMs: 12 * 3_600_000,
      maxScryptLogN: 18,
      idle: { ms: 15 * 60_000, activity: "request" },
    },
    backends: {
      nostr: nobleBackend,
      spark: async () => Promise.reject(new Error("spark backend unavailable in test")),
    },
  };
}

/**
 * One shared byte holder = one vault.cbor file. Each kernel runtime gets its own createFileStore
 * view over it — the exact arrangement the native side has when two KernelHost hybrid objects
 * exist in one app.
 */
const fileStore = (bytes: { value: Uint8Array | undefined }) =>
  createFileStore({
    read: () => bytes.value,
    write: (b) => {
      bytes.value = b;
    },
  });

const boot = (store: ReturnType<typeof createMemoryStore>, keystore: KernelKeystoreNative) => {
  const { host, pipe } = makePipe();
  startKernel(platform(store, keystore), createKernelPort(pipe));
  return host;
};

type AnyWallet = Awaited<ReturnType<typeof createNativeWallet>>;

const connect = (host: KernelHostLike): Promise<AnyWallet> =>
  createNativeWallet({
    verifyEvent,
    passkey: PASSKEY,
    autoLock: AUTOLOCK,
    createHost: () => host,
  });

describe("HN-02: two kernels over one vault file", () => {
  it("scenario 1 — a second importMnemonic on a stale-initialized kernel silently wipes the first vault", async () => {
    // One device keystore, one vault file, two live kernels — both boot before any vault exists.
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const walletA = await connect(boot(fileStore(bytes), keystore.native));
    const walletB = await connect(boot(fileStore(bytes), keystore.native));
    expect(walletA.getSnapshot().vault).toBe("uninitialized");
    expect(walletB.getSnapshot().vault).toBe("uninitialized");
    try {
      const a = await walletA.wallets.importMnemonic({ mnemonic: M1 });
      // A safe store would fail B's `init` precondition ("already initialized" / "conflict"):
      // B's kernel checks its own cache — still EMPTY — so the init succeeds and its file write
      // wholesale replaces the vault A just wrote.
      const b = await walletB.wallets.importMnemonic({ mnemonic: M2 });
      expect(b.walletId).not.toBe(a.walletId);

      // A third runtime cold-loads the file: only B's vault remains — A's wallet record is gone.
      const walletC = await connect(boot(fileStore(bytes), keystore.native));
      try {
        await walletC.vault.unlock();
        const ids = walletC.getSnapshot().wallets.map((w) => w.walletId);
        expect(ids).toStrictEqual([b.walletId]);
        expect(ids).not.toContain(a.walletId);
      } finally {
        await walletC.destroy();
      }

      // A's own view is stale: it still believes its wallet exists in the vault.
      expect(walletA.getSnapshot().wallets.map((w) => w.walletId)).toContain(a.walletId);
    } finally {
      await walletA.destroy();
      await walletB.destroy();
    }
  });

  it("scenario 2 — a stale-revision commit drops another runtime's committed record", async () => {
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const walletA = await connect(boot(fileStore(bytes), keystore.native));
    try {
      const { walletId } = await walletA.wallets.importMnemonic({ mnemonic: M1 });
      // B boots AFTER A initialized — its one file read gives it the initialized vault, which it
      // then caches. Nothing ever refreshes B's cache against A's later commits.
      const walletB = await connect(boot(fileStore(bytes), keystore.native));
      try {
        await walletA.vault.unlock();
        await walletB.vault.unlock();
        // A commits a nostr key at index 1 (revision N → N+1, file now has key 1)…
        const one = await nostr(walletA).deriveKey(walletId, 1);
        // …then B commits key index 2. B's expect-revision is checked against its cached
        // revision N — still matching — so the commit succeeds and rewrites the file from B's
        // stale image, dropping A's key-1 record.
        const two = await nostr(walletB).deriveKey(walletId, 2);
        expect(two.publicKey).not.toBe(one.publicKey);

        // A cold reader sees only B's key: A's committed record is silently gone.
        const walletC = await connect(boot(fileStore(bytes), keystore.native));
        try {
          await walletC.vault.unlock();
          const indices = walletC.getSnapshot().nostr.keys.map((k) => k.ref.index);
          expect(indices).toContain(2);
          expect(indices).not.toContain(1);
        } finally {
          await walletC.destroy();
        }

        // Both racing kernels keep their stale views — A still shows index 1, B never saw it.
        expect(walletA.getSnapshot().nostr.keys.map((k) => k.ref.index)).toContain(1);
        expect(walletB.getSnapshot().nostr.keys.map((k) => k.ref.index)).not.toContain(1);
      } finally {
        await walletB.destroy();
      }
    } finally {
      await walletA.destroy();
    }
  });
});
