import { pbkdf2 as nodePbkdf2 } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { nobleBackend, verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";

import { startKernel } from "../../wallet-kernel/src/index.ts";
import type { KernelPlatform, createMemoryStore } from "../../wallet-kernel/src/index.ts";
import { bindNativeKeystore } from "../kernel/keystore.ts";
import type { KernelKeystoreNative } from "../kernel/keystore.ts";
import { createFileStore } from "../kernel/store.ts";
import { createKernelPort } from "../kernel/transport.ts";
import type { KernelFramePipe } from "../kernel/transport.ts";
import { FRAME_MAX_BYTES } from "../src/cbor.ts";
import type { KernelHostLike, KernelExitReason } from "../src/host.ts";
import { createNativeWallet, spawnFromHost } from "../src/index.ts";

const PASSKEY: PasskeyConfig = {
  rpId: "harness.test",
  rpName: "Harness",
  walletSalt: "wallet",
  vaultSalt: "vault",
  backupSalt: "backup",
};
const AUTOLOCK: AutoLockPolicy = { platform: "native", backgroundSeconds: 60 };

/**
 * A `__qntx.keystore` stand-in with the native completion shape: sealing reverses the bytes, keys
 * live per id, and `failNext` makes the next prompting call complete with a native failure code.
 */
function fakeNativeKeystore() {
  const keys = new Map<string, Uint8Array>();
  const failures: string[] = [];
  const later = (fn: () => void) => {
    setTimeout(fn);
  };
  // Reversible stand-in for platform encryption: byte order reversed.
  const seal = (bytes: Uint8Array) => bytes.toReversed();
  const native: KernelKeystoreNative = {
    locale: "en-US",
    seal: (id, secret, _title, _description, done) => {
      const code = failures.shift();
      const sealed = seal(secret);
      if (code === undefined) {
        keys.set(id, sealed);
      }
      later(() => {
        done(code === undefined ? sealed : undefined, code);
      });
    },
    open: (id, sealed, _title, _description, done) => {
      const code = failures.shift();
      const known = keys.get(id);
      later(() => {
        if (code !== undefined) {
          done(undefined, code);
          return;
        }
        done(
          known === undefined ? undefined : seal(sealed),
          known === undefined ? "factor-invalidated" : undefined,
        );
      });
    },
    authenticate: (_title, _description, done) => {
      const code = failures.shift();
      later(() => {
        done(undefined, code);
      });
    },
    clear: (done) => {
      keys.clear();
      later(() => {
        done(undefined, undefined);
      });
    },
  };
  return { native, failNext: (code: string) => failures.push(code) };
}

/** In-memory frame pipe: host wrapper (MainPort) ↔ kernel-side transport (Port). */
type FakeHost = KernelHostLike & {
  readonly inbound: (f: ArrayBuffer) => void;
  readonly locked: () => boolean;
  readonly _integrity: () => void;
};

function makePipe(): { host: FakeHost; pipe: KernelFramePipe } {
  let hostCb: ((f: ArrayBuffer) => void) | undefined;
  let kernelCb: ((f: ArrayBuffer) => void) | undefined;
  let exitCb: ((r: KernelExitReason) => void) | undefined;
  let integCb: (() => void) | undefined;
  let locked = false;
  const pipe: KernelFramePipe = {
    post: (frame) => hostCb?.(frame),
    onMessage: (cb) => {
      kernelCb = cb;
    },
    onIntegrityViolation: (cb) => {
      integCb = cb;
    },
  };
  const host = {
    start: (_seconds: number) => {},
    post: (frame) => {
      kernelCb?.(frame);
    },
    onMessage: (cb) => {
      hostCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    lock: () => {
      locked = true;
      exitCb?.("locked");
    },
    inbound: (f: ArrayBuffer) => {
      hostCb?.(f);
    },
    locked: () => locked,
    _integrity: () => integCb?.(),
  } as KernelHostLike & {
    inbound: (f: ArrayBuffer) => void;
    locked: () => boolean;
    _integrity: () => void;
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
    now: () => Date.now(),
    elapsed: () => performance.now(),
    setTimer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
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

// An in-memory __qntx.file: the byte holder outlives a crashed kernel so persistence across
// rebuild is exercised end to end — identical to the native file primitive's guarantee. Each
// test gets its own holder; the crash test shares one across both boots.
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

describe("createNativeWallet", () => {
  it("rejects a non-native autoLock policy", async () => {
    const { host } = makePipe();
    await expect(
      createNativeWallet({ passkey: PASSKEY, autoLock: { platform: "web", idleMinutes: 5 }, host }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("mnemonic ceremony, import, unlock, nostr sign, lock, crash and rebuild", async () => {
    // Vault A covers the mnemonic-create ceremony; vault B covers import — both
    // methods are one-shot vault initializers. Both establish the hardware factor by default.
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const hostA = boot(fileStore(bytes), fakeNativeKeystore().native);
    const walletA = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host: hostA });
    const draft = await walletA.wallets.createMnemonic({ words: 12 });
    const words = new TextDecoder().decode(draft.words.read()).split(" ");
    await draft.confirm(draft.quiz.map((i) => words[i]!));
    expect(walletA.getSnapshot().factors.map((f) => f.kind)).toStrictEqual(["hardware"]);

    const bytesB = { value: undefined as Uint8Array | undefined };
    const host = boot(fileStore(bytesB), keystore.native);
    const wallet = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host });
    await expect(
      wallet.wallets.importMnemonic({
        mnemonic: words.join(" "),
        factor: { kind: "password", password: "correct horse battery staple" },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "factor-unavailable" }));
    const imported = await wallet.wallets.importMnemonic({ mnemonic: words.join(" ") });
    const { walletId } = imported;

    const api = nostr(wallet);
    const key = await api.deriveKey(walletId, 0);
    const event = await api.signer(key.ref).signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "native wallet test",
      pubkey: key.publicKey,
    });
    expect(verifyEvent(event)).toBe(true);

    await wallet.vault.lock();

    // Simulated host crash: the runtime dies; a fresh host+kernel on the same store recovers.
    const host2 = boot(fileStore(bytesB), keystore.native);
    const wallet2 = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host: host2 });
    keystore.failNext("cancelled");
    await expect(wallet2.vault.unlock()).rejects.toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(wallet2.getSnapshot().vault).toBe("locked");
    await wallet2.vault.unlock();
    expect(wallet2.getSnapshot().vault).toBe("unlocked");
  });
});

describe("frame discipline", () => {
  it("oversized inbound frame exits the port and locks the host", () => {
    const { host } = makePipe();
    const port = spawnFromHost(host, 0);
    let exited = false;
    port.onExit(() => {
      exited = true;
    });
    host.inbound(new Uint8Array(FRAME_MAX_BYTES + 1).buffer);
    expect(exited).toBe(true);
    expect(host.locked()).toBe(true);
  });

  it("garbage inbound frame exits the port and locks the host", () => {
    const { host } = makePipe();
    const port = spawnFromHost(host, 0);
    let exited = false;
    port.onExit(() => {
      exited = true;
    });
    host.inbound(Uint8Array.from([0xff, 0xff, 0xff]).buffer);
    expect(exited).toBe(true);
    expect(host.locked()).toBe(true);
  });

  it("post zero-fills the transfer buffers", () => {
    const { host } = makePipe();
    const port = spawnFromHost(host, 0);
    const secret = new Uint8Array([1, 2, 3, 4]).buffer;
    port.post({ id: 1 }, [secret]);
    expect(new Uint8Array(secret)).toStrictEqual(new Uint8Array(4));
  });
});
