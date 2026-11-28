import { argon2Sync, pbkdf2 as nodePbkdf2 } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import { nobleBackend, verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";

import { startKernel } from "../../wallet-kernel/src/index.ts";
import type { KernelPlatform, createMemoryStore } from "../../wallet-kernel/src/index.ts";
import { bindNativeAnchor } from "../kernel/anchor.ts";
import type { KernelAnchorNative } from "../kernel/anchor.ts";
import { bindNativeKeystore } from "../kernel/keystore.ts";
import type { KernelKeystoreNative } from "../kernel/keystore.ts";
import { createFileStore } from "../kernel/store.ts";
import { createKernelPort } from "../kernel/transport.ts";
import type { KernelFramePipe } from "../kernel/transport.ts";
import type { KernelHostLike, KernelExitReason } from "../src/host.ts";
import { createNativeWallet } from "../src/index.ts";

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
const M2 = "legal winner thank year wave sausage worth useful legal winner thank yellow";

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
    platform: "ios",
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
  readonly _exit: (reason: KernelExitReason) => void;
};

function makePipe(): { host: FakeHost; pipe: KernelFramePipe } {
  let hostCb: ((f: ArrayBuffer) => void) | undefined;
  let kernelCb: ((f: ArrayBuffer) => void) | undefined;
  let exitCb: ((r: KernelExitReason) => void) | undefined;
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
    _exit: (reason: KernelExitReason) => exitCb?.(reason),
  } as KernelHostLike & {
    inbound: (f: ArrayBuffer) => void;
    locked: () => boolean;
    backgroundLock: () => number | undefined;
    started: () => number[];
    _exit: (reason: KernelExitReason) => void;
  };
  return { host, pipe };
}

function platform(
  store: ReturnType<typeof createMemoryStore>,
  keystore: KernelKeystoreNative,
  anchor: KernelAnchorNative,
): KernelPlatform {
  return {
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    keystore: bindNativeKeystore(keystore),
    anchor: bindNativeAnchor(anchor),
    passkey: undefined,
    card: undefined,
    secureInput: undefined,
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
 * view over it — the exact arrangement the native side has when two KernelHost hybrid objects exist
 * in one app (or the file is shared across processes). The `replace` fake is the CAS the C++
 * primitive provides under the vault lock.
 */
const fileStore = (bytes: { value: Uint8Array | undefined }) =>
  createFileStore({
    read: () => bytes.value,
    replace: (next, expected) => {
      const matches =
        expected === undefined
          ? bytes.value === undefined
          : bytes.value !== undefined &&
            bytes.value.length === expected.length &&
            bytes.value.every((v, i) => v === expected[i]);
      if (!matches) {
        return false;
      }
      bytes.value = next;
      return true;
    },
  });

// An in-memory __qntx.anchor with the native compare-and-swap semantics — like the file, the
// holder stands in for the platform keystore and outlives a crashed kernel.
const nativeAnchor = (bytes: { value: Uint8Array | undefined }): KernelAnchorNative => ({
  read: () => bytes.value,
  replace: (next, expected) => {
    const matches =
      expected === undefined
        ? bytes.value === undefined
        : bytes.value !== undefined &&
          bytes.value.length === expected.length &&
          bytes.value.every((v, i) => v === expected[i]);
    if (!matches) {
      return false;
    }
    bytes.value = next;
    return true;
  },
});

const boot = (
  store: ReturnType<typeof createMemoryStore>,
  keystore: KernelKeystoreNative,
  anchor: KernelAnchorNative,
) => {
  const { host, pipe } = makePipe();
  startKernel(platform(store, keystore, anchor), createKernelPort(pipe));
  return host;
};

type AnyWallet = Awaited<ReturnType<typeof createNativeWallet>>;

const connect = async (host: KernelHostLike): Promise<AnyWallet> =>
  createNativeWallet({
    verifyEvent,
    passkey: PASSKEY,
    autoLock: AUTOLOCK,
    createHost: () => host,
  });

describe("two kernels over one vault file", () => {
  it("a second kernel's importMnemonic conflicts instead of wiping the first vault", async () => {
    // One vault file, two live kernels — both boot before any vault exists. A and C share one
    // device keystore (C is A's kernel restarted); B is a foreign writer — its establish calls
    // keystore.clear(), which must not reach A's keys, so B gets its own namespace.
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const anchor = nativeAnchor({ value: undefined });
    const walletA = await connect(boot(fileStore(bytes), keystore.native, anchor));
    const walletB = await connect(boot(fileStore(bytes), fakeNativeKeystore().native, anchor));
    expect(walletA.getSnapshot().vault.status).toBe("uninitialized");
    expect(walletB.getSnapshot().vault.status).toBe("uninitialized");
    try {
      const a = await walletA.wallets.importMnemonic({ mnemonic: M1 });
      // B's `init` precondition is judged against the file A just wrote — the store reads at
      // commit time, never from a cached image.
      await expect(walletB.wallets.importMnemonic({ mnemonic: M2 })).rejects.toThrow(
        expect.objectContaining({ code: "conflict" }),
      );
      // A cold kernel reads the committed file: only A's vault exists.
      const walletC = await connect(boot(fileStore(bytes), keystore.native, anchor));
      try {
        await walletC.vault.unlock();
        expect(walletC.getSnapshot().wallets.map((w) => w.walletId)).toStrictEqual([a.walletId]);
      } finally {
        await walletC.destroy();
      }
    } finally {
      await walletA.destroy();
      await walletB.destroy();
    }
  });

  it("a stale-revision commit conflicts and drops no committed record", async () => {
    // One device keystore shared by all three: B only ever commits records (no init, so no
    // keystore.clear), so A's sealed keys survive for B's unlock and C's cold read.
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const anchor = nativeAnchor({ value: undefined });
    const walletA = await connect(boot(fileStore(bytes), keystore.native, anchor));
    try {
      const { walletId } = await walletA.wallets.importMnemonic({ mnemonic: M1 });
      // B boots after A initialized — its load sees the initialized vault.
      const walletB = await connect(boot(fileStore(bytes), keystore.native, anchor));
      try {
        await walletA.vault.unlock();
        await walletB.vault.unlock();
        // A commits a nostr key at index 1 (revision N → N+1)…
        const one = await nostr(walletA).deriveKey(walletId, 1);
        // …then B commits index 2. B's expect-revision is checked against the file's truth —
        // already N+1 — so the commit conflicts instead of rewriting a stale image.
        await expect(nostr(walletB).deriveKey(walletId, 2)).rejects.toThrow(
          expect.objectContaining({ code: "conflict" }),
        );
        void one;

        // A cold reader sees A's committed record — B's lost race dropped nothing.
        const walletC = await connect(boot(fileStore(bytes), keystore.native, anchor));
        try {
          await walletC.vault.unlock();
          const indices = walletC.getSnapshot().nostr.keys.map((k) => k.ref.index);
          expect(indices).toStrictEqual([1]);
        } finally {
          await walletC.destroy();
        }
      } finally {
        await walletB.destroy();
      }
    } finally {
      await walletA.destroy();
    }
  });
});
