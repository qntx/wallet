/**
 * HN-04 — the main-side Channel has no in-flight bound while the native inbound queue caps at 64.
 *
 * What it demonstrates: Channel.call (packages/wallet/src/channel.ts) posts every concurrent
 * request to the port immediately. The native KernelRuntime's inbound queue drops frames beyond
 * kMaxInboundFrames = 64 (cpp/runtime/KernelRuntime.cpp:89,206; the C++ host test
 * RuntimeHostTest.cpp queueCap() covers the drop + `integrity` exit). Modeling a busy kernel —
 * the fake host counts frames but stops delivering them — 100 concurrent dataKeys.get calls
 * produce 100 outbound posts, so frames 65..100 would already be dropped on a real runtime and
 * the integrity exit would tear the session down.
 *
 * passes = vulnerable (a bounded channel would refuse/backpressure before post #65).
 */
import { argon2Sync, pbkdf2 as nodePbkdf2 } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import { nobleBackend, verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig } from "@qntx/wallet";

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

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

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

const fileStore = (bytes: { value: Uint8Array | undefined }) =>
  createFileStore({
    read: () => bytes.value,
    write: (b) => {
      bytes.value = b;
    },
  });

describe("HN-04: the main-side channel applies no backpressure", () => {
  it("posts all 100 concurrent requests while the native inbound queue can only hold 64", async () => {
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const { host: inner, pipe } = makePipe();
    startKernel(platform(fileStore(bytes), keystore.native), createKernelPort(pipe));

    // Wrap the fake host's post: count every outbound frame; when `hold` is set the frames stop
    // reaching the kernel — a kernel thread busy in synchronous JS never drains its queue.
    let hold = false;
    const posted: ArrayBuffer[] = [];
    const host: KernelHostLike = {
      start: (s) => inner.start(s),
      post: (frame) => {
        posted.push(frame);
        if (!hold) {
          inner.post(frame);
        }
      },
      onMessage: (cb) => inner.onMessage(cb),
      onExit: (cb) => inner.onExit(cb),
      setBackgroundLock: (s) => inner.setBackgroundLock(s),
      lock: () => inner.lock(),
    };

    const wallet = await createNativeWallet({
      verifyEvent,
      passkey: PASSKEY,
      autoLock: AUTOLOCK,
      createHost: () => host,
    });
    try {
      await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC });
      const before = posted.length;

      hold = true;
      // Fire 100 concurrent requests without awaiting — the channel posts each immediately.
      const pendingCalls = Array.from({ length: 100 }, (_, i) =>
        wallet.dataKeys.get(`p${i}`).then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        ),
      );
      // Flush the microtasks between call() and port.post (the readyPromise await).
      await new Promise<void>((resolve) => {
        setTimeout(resolve);
      });
      // No bound on the host side: all 100 requests were posted — 36 frames past the kernel
      // runtime's kMaxInboundFrames = 64 inbound cap (KernelRuntime.cpp:89). On a real runtime
      // every frame past 64 is dropped and the runtime exits `integrity`.
      expect(posted.length - before).toBe(100);
      expect(posted.length - before).toBeGreaterThan(64);

      await wallet.destroy(); // rejects the held requests ("locked"), stops the watchdog
      const settled = await Promise.all(pendingCalls);
      expect(settled.every((r) => !r.ok)).toBe(true);
    } finally {
      await wallet.destroy();
    }
  });
});
