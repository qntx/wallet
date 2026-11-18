import { argon2Sync, pbkdf2 as nodePbkdf2 } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

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

/**
 * A `__qntx.keystore` stand-in with the native completion shape: sealing reverses the bytes, keys
 * live per id, presence work needs the lock screen, and `failNext` makes the next call complete
 * with a native failure code.
 */
function fakeNativeKeystore() {
  const keys = new Map<string, Uint8Array>();
  const presence = new Set<string>();
  const failures: string[] = [];
  let lockScreen = true;
  const later = (fn: () => void) => {
    setTimeout(fn);
  };
  // Reversible stand-in for platform encryption: byte order reversed.
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

// An in-memory __qntx.file with the native compare-and-swap semantics: the byte holder outlives a
// crashed kernel so persistence across rebuild is exercised end to end — identical to the native
// file primitive's guarantee. Each test gets its own holder; the crash test shares one across
// both boots.
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

const boot = (store: ReturnType<typeof createMemoryStore>, keystore: KernelKeystoreNative) => {
  const { host, pipe } = makePipe();
  startKernel(platform(store, keystore), createKernelPort(pipe));
  return host;
};

describe("createNativeWallet", () => {
  it("rejects a non-native autoLock policy", async () => {
    const { host } = makePipe();
    await expect(
      createNativeWallet({
        verifyEvent,
        passkey: PASSKEY,
        autoLock: { platform: "web", idleMinutes: 5 },
        createHost: () => host,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("mnemonic ceremony, import, unlock, nostr sign, lock, crash and rebuild", async () => {
    // Vault A covers the mnemonic-create ceremony; vault B covers import — both
    // methods are one-shot vault initializers. Both establish the hardware factor by default.
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const hostA = boot(fileStore(bytes), fakeNativeKeystore().native);
    const walletA = await createNativeWallet({
      verifyEvent,
      passkey: PASSKEY,
      autoLock: AUTOLOCK,
      createHost: () => hostA,
    });
    const draft = await walletA.wallets.createMnemonic({ words: 12 });
    const words = new TextDecoder().decode(draft.words.read()).split(" ");
    await draft.confirm(draft.quiz.map((i) => words[i]!));
    expect(walletA.getSnapshot().factors.map((f) => f.kind)).toStrictEqual(["device", "hardware"]);

    const bytesB = { value: undefined as Uint8Array | undefined };
    const host = boot(fileStore(bytesB), keystore.native);
    const wallet = await createNativeWallet({
      verifyEvent,
      passkey: PASSKEY,
      autoLock: AUTOLOCK,
      createHost: () => host,
    });
    await expect(
      wallet.wallets.importMnemonic({
        mnemonic: words.join(" "),
        factor: { kind: "password", password: "correct horse battery staple" },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "unsupported" }));
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
    const wallet2 = await createNativeWallet({
      verifyEvent,
      passkey: PASSKEY,
      autoLock: AUTOLOCK,
      createHost: () => host2,
    });
    keystore.failNext("cancelled");
    await expect(wallet2.vault.unlock()).rejects.toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(wallet2.getSnapshot().vault).toBe("locked");
    await wallet2.vault.unlock();
    expect(wallet2.getSnapshot().vault).toBe("unlocked");
  });
});

/** A wallet whose every kernel runtime gets a fresh host over one persistent vault. */
async function openWallet() {
  const keystore = fakeNativeKeystore();
  const bytes = { value: undefined as Uint8Array | undefined };
  const hosts: FakeHost[] = [];
  const wallet = await createNativeWallet({
    verifyEvent,
    passkey: PASSKEY,
    autoLock: AUTOLOCK,
    createHost: () => {
      const host = boot(fileStore(bytes), keystore.native);
      hosts.push(host);
      return host;
    },
  });
  return { wallet, hosts };
}

async function createMnemonicWallet(wallet: Awaited<ReturnType<typeof openWallet>>["wallet"]) {
  const draft = await wallet.wallets.createMnemonic({ words: 12 });
  const words = new TextDecoder().decode(draft.words.read()).split(" ");
  const created = await draft.confirm(draft.quiz.map((i) => words[i]!));
  return { walletId: created.walletId, phrase: words.join(" ") };
}

describe("kernel restarts", () => {
  it("unlocks in the same process after a lock, twice in a row", async () => {
    const { wallet, hosts } = await openWallet();
    await createMnemonicWallet(wallet);
    expect(hosts).toHaveLength(1);
    await wallet.vault.lock();
    expect(wallet.getSnapshot().vault).toBe("locked");
    await wallet.vault.unlock();
    expect(wallet.getSnapshot().vault).toBe("unlocked");
    expect(hosts).toHaveLength(2);
    await wallet.vault.lock();
    expect(wallet.getSnapshot().vault).toBe("locked");
    await wallet.vault.unlock();
    expect(wallet.getSnapshot().vault).toBe("unlocked");
    expect(hosts).toHaveLength(3);
    expect(hosts.slice(0, -1).every((host) => host.locked())).toBe(true);
  });

  it("creates again after the last wallet is deleted", async () => {
    const { wallet } = await openWallet();
    const first = await createMnemonicWallet(wallet);
    await wallet.wallets.delete(first.walletId, { kind: "hardware" });
    expect(wallet.getSnapshot().wallets).toHaveLength(0);
    expect(wallet.getSnapshot().vault).toBe("unlocked");
    const imported = await wallet.wallets.importMnemonic({ mnemonic: first.phrase });
    expect(imported.walletId).toBe(first.walletId);
    expect(wallet.getSnapshot().vault).toBe("unlocked");
  });
});

describe("setAutoLock and the host factory", () => {
  it("rejects policies outside the native background-seconds set", async () => {
    const { wallet } = await openWallet();
    expect(() => wallet.setAutoLock({ platform: "web", idleMinutes: 5 } as never)).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
    expect(() => wallet.setAutoLock({ platform: "native", backgroundSeconds: 5 } as never)).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
  });

  it("applies the budget to the live host and to every later spawn", async () => {
    const { wallet, hosts } = await openWallet();
    await createMnemonicWallet(wallet);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.started()).toStrictEqual([60]);

    wallet.setAutoLock({ platform: "native", backgroundSeconds: 300 });
    expect(hosts[0]!.backgroundLock()).toBe(300);

    await wallet.vault.lock();
    await wallet.vault.unlock();
    expect(hosts).toHaveLength(2);
    expect(hosts[1]!.started()).toStrictEqual([300]);

    wallet.setAutoLock({ platform: "native", backgroundSeconds: 0 });
    expect(hosts[1]!.backgroundLock()).toBe(0);
  });

  it("builds the Nitro KernelHost when no createHost is given", async () => {
    const { NitroModules } = await import("react-native-nitro-modules");
    const createHybridObject = vi.mocked(NitroModules.createHybridObject);
    const bytes = { value: undefined as Uint8Array | undefined };
    const keystore = fakeNativeKeystore();
    // oxlint-disable-next-line vitest/prefer-mock-return-shorthand -- every spawn needs a fresh host
    createHybridObject.mockImplementation(() => boot(fileStore(bytes), keystore.native) as never);
    const wallet = await createNativeWallet({
      verifyEvent,
      passkey: PASSKEY,
      autoLock: AUTOLOCK,
    });
    await expect(wallet.vault.unlock()).rejects.toThrow(
      expect.objectContaining({ code: expect.any(String) as string }),
    );
    expect(createHybridObject).toHaveBeenCalledWith("KernelHost");
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

  it("maps a platform background exit to background and other exits to crashed", () => {
    const { host } = makePipe();
    const port = spawnFromHost(host, 0);
    const background: string[] = [];
    port.onExit((reason) => {
      background.push(reason);
    });
    host._exit("background");
    expect(background).toStrictEqual(["background"]);

    const { host: other } = makePipe();
    const port2 = spawnFromHost(other, 0);
    const crashed: string[] = [];
    port2.onExit((reason) => {
      crashed.push(reason);
    });
    other._exit("integrity");
    expect(crashed).toStrictEqual(["crashed"]);
  });

  it("post zero-fills the transfer buffers", () => {
    const { host } = makePipe();
    const port = spawnFromHost(host, 0);
    const secret = new Uint8Array([1, 2, 3, 4]).buffer;
    port.post({ id: 1 }, [secret]);
    expect(new Uint8Array(secret)).toStrictEqual(new Uint8Array(4));
  });
});
