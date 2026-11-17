/**
 * HN-01 — kernel→host CBOR transport drops a response it cannot encode, and the kernel posts
 * responses OUTSIDE the request try/finally.
 *
 * What it demonstrates:
 *  1. `encodeFrame` rejects any string with a lone UTF-16 surrogate (src/cbor.ts checkString →
 *     CborError "lone-surrogate"), so `createKernelPort`'s `post` throws for such a response,
 *     while `structuredClone` (the Web/Node transport) would carry the same string untouched.
 *  2. A gift wrap whose decrypted rumor JSON carries a `\ud800` escape is the described delivery
 *     vector. In THIS tree @qntx/nostr@0.15.4 already blocks it: `unwrap` → `parseRumor` →
 *     `validateEvent` → `hasLoneSurrogate`, so the wrap resolves as an `{err:"integrity"}` item —
 *     see "the described NIP-59 vector is currently blocked" below.
 *  3. The armed trap is still real: kernel.ts handle() calls `post(response)` after the finally
 *     (kernel.ts ~line 362). We arm the kernel-side Port's post to throw the exact CborError the
 *     encoder produces for a lone-surrogate payload — same call site, same propagation — and show
 *     the response is lost, the host call stays pending, and the 60 s channel watchdog
 *     (wallet/src/channel.ts CALL_TIMEOUT_MS) rejects it "crashed" and ends the session.
 *
 * passes = vulnerable (parts 1 and 3 assert the defect; part 2 documents the dep-level block).
 */
import { argon2Sync, pbkdf2 as nodePbkdf2 } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import { Keys, KeysSigner, nobleBackend, verifyEvent } from "@qntx/nostr";
import { createGiftWrap, createRumor, wrap } from "@qntx/nostr/nips/nip59";
import type { AutoLockPolicy, PasskeyConfig } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { startKernel } from "../../../wallet-kernel/src/index.ts";
import type { KernelPlatform, createMemoryStore } from "../../../wallet-kernel/src/index.ts";
import { bindNativeKeystore } from "../../kernel/keystore.ts";
import type { KernelKeystoreNative } from "../../kernel/keystore.ts";
import { createFileStore } from "../../kernel/store.ts";
import { createKernelPort } from "../../kernel/transport.ts";
import type { KernelFramePipe } from "../../kernel/transport.ts";
import { CborError, encodeFrame } from "../../src/cbor.ts";
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

// An in-memory __qntx.file: one byte holder per test, one fileStore view per kernel runtime —
// identical to the native file primitive's guarantee.
const fileStore = (bytes: { value: Uint8Array | undefined }) =>
  createFileStore({
    read: () => bytes.value,
    write: (b) => {
      bytes.value = b;
    },
  });

describe("HN-01: the CBOR transport rejects lone surrogates that structuredClone carries", () => {
  it("encodeFrame and the kernel-side Port.post throw lone-surrogate; structuredClone does not", () => {
    const frame = { s: "hi \ud800" } as unknown as ProtocolValue;
    expect(() => encodeFrame(frame)).toThrow(
      expect.objectContaining({ name: "CborError", code: "lone-surrogate" }) as unknown as Error,
    );

    const posted: ArrayBuffer[] = [];
    const pipe: KernelFramePipe = {
      post: (f) => {
        posted.push(f);
      },
      onMessage: () => {},
      onIntegrityViolation: () => {},
    };
    const port = createKernelPort(pipe);
    // The exact response shape a NIP-59 unwrap with a lone-surrogate rumor would produce.
    const response = {
      v: 3,
      id: 1,
      ok: { results: [{ ok: { content: "\ud800" } }] },
    } as unknown as ProtocolValue;
    expect(() => port.post(response, [])).toThrow(
      expect.objectContaining({ name: "CborError", code: "lone-surrogate" }) as unknown as Error,
    );
    // post() throws in encodeFrame — no frame reaches the host.
    expect(posted).toHaveLength(0);

    // Contrast: the Web/Node structuredClone transport carries the identical string untouched —
    // the RN CBOR transport is the only one that kills it.
    expect(structuredClone("hi \ud800")).toBe("hi \ud800");
  });
});

describe("HN-01 end to end: a gift wrap reaching an un-encodable kernel response", () => {
  type Trap = {
    readonly host: FakeHost;
    readonly postErrors: unknown[];
    readonly arm: () => void;
  };

  /**
   * Boots a kernel whose kernel-side Port.post can be armed to throw the exact CborError
   * encodeFrame produces for a lone-surrogate payload — at the same call site (Port.post is
   * where encodeFrame runs, kernel/transport.ts:45) with the same propagation into
   * kernel.ts handle()'s unguarded `post(response)`.
   */
  const bootTrapped = (
    store: ReturnType<typeof createMemoryStore>,
    keystore: KernelKeystoreNative,
  ): Trap => {
    const { host, pipe } = makePipe();
    const inner = createKernelPort(pipe);
    const postErrors: unknown[] = [];
    let armed = false;
    startKernel(platform(store, keystore), {
      post: (message, transfer) => {
        if (armed && typeof message === "object" && message !== null && "id" in message) {
          armed = false;
          const error = new CborError(
            "lone-surrogate",
            "cbor frame: string with a lone UTF-16 surrogate",
          );
          postErrors.push(error);
          throw error;
        }
        inner.post(message, transfer);
      },
      listen: inner.listen,
    });
    return {
      host,
      postErrors,
      arm: () => {
        armed = true;
      },
    };
  };

  const boot = (store: ReturnType<typeof createMemoryStore>, keystore: KernelKeystoreNative) => {
    const { host, pipe } = makePipe();
    startKernel(platform(store, keystore), createKernelPort(pipe));
    return host;
  };

  it("control wrap unwraps; a lone-surrogate rumor resolves as an item error (dep blocks the vector)", async () => {
    const keystore = fakeNativeKeystore();
    const bytes = { value: undefined as Uint8Array | undefined };
    const host = boot(fileStore(bytes), keystore.native);
    const wallet = await createNativeWallet({
      verifyEvent,
      passkey: PASSKEY,
      autoLock: AUTOLOCK,
      createHost: () => host,
    });
    try {
      const { walletId } = await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC });
      const api = nostr(wallet);
      const key = await api.deriveKey(walletId, 0);
      const signer = api.signer(key.ref);

      const sender = new KeysSigner(Keys.generate());
      const senderPub = await sender.getPublicKey();

      // Control: an ordinary kind-14 DM rumor wrapped by a random sender.
      const control = await wrap(
        sender,
        key.publicKey,
        createRumor(senderPub, { kind: 14, content: "hello" }),
      );
      const results = await signer.unwrapGiftWraps([control]);
      expect(results).toHaveLength(1);
      const rumor = results[0];
      expect(rumor).not.toBeInstanceOf(Error);
      expect((rumor as { content: string }).content).toBe("hello");

      // Attack: the seal's plaintext JSON carries the escape `\ud800`, so JSON.parse inside the
      // kernel's unwrap yields a real lone UTF-16 surrogate in the rumor's content.
      const crafted = `{"id":"${"0".repeat(64)}","pubkey":"${senderPub}","created_at":1700000000,"kind":14,"tags":[],"content":"hello \\ud800 world"}`;
      const sealContent = await sender.nip44Encrypt(key.publicKey, crafted);
      const seal = await sender.signEvent({
        kind: 13,
        content: sealContent,
        created_at: 1700000001,
        tags: [],
        pubkey: senderPub,
      });
      const attack = createGiftWrap(seal, key.publicKey);
      const attackResults = await signer.unwrapGiftWraps([attack]);
      // HN-01's described vector is currently blocked one layer up: @qntx/nostr's unwrap →
      // parseRumor → validateEvent → hasLoneSurrogate rejects the parsed rumor, so the kernel
      // answers {err:"integrity"} instead of building an un-encodable response. The transport
      // trap this finding reports remains armed for any producer that reaches it (part 3).
      expect(attackResults).toHaveLength(1);
      expect(attackResults[0]).toBeInstanceOf(Error);
    } finally {
      await wallet.destroy();
    }
  });

  it("a kernel response that fails to encode never arrives: the call wedges until the watchdog crashes the session", async () => {
    const unhandled: unknown[] = [];
    const collector = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", collector);
    try {
      const keystore = fakeNativeKeystore();
      const bytes = { value: undefined as Uint8Array | undefined };
      const trap = bootTrapped(fileStore(bytes), keystore.native);
      // Like NitroModules.createHybridObject("KernelHost"): every spawn is a fresh runtime —
      // the first one carries the armed post trap, later respawns boot cleanly.
      let first = true;
      const wallet = await createNativeWallet({
        verifyEvent,
        passkey: PASSKEY,
        autoLock: AUTOLOCK,
        createHost: () => {
          if (first) {
            first = false;
            return trap.host;
          }
          return boot(fileStore(bytes), keystore.native);
        },
      });
      try {
        const { walletId } = await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC });
        const api = nostr(wallet);
        const key = await api.deriveKey(walletId, 0);
        const signer = api.signer(key.ref);

        const sender = new KeysSigner(Keys.generate());
        const control = await wrap(
          sender,
          key.publicKey,
          createRumor(await sender.getPublicKey(), { kind: 14, content: "hello" }),
        );

        vi.useFakeTimers();
        try {
          trap.arm();
          // The wedged call: its response is what would carry the surrogate rumor — the kernel
          // computes it, Port.post throws encoding it, and handle() lets the task reject.
          const wedged = signer.unwrapGiftWraps([control]);
          let wedgedSettled = false;
          void wedged.then(
            () => {
              wedgedSettled = true;
            },
            () => {
              wedgedSettled = true;
            },
          );
          // A second request rides the same kernel queue immediately behind the wedged one; its
          // enqueue attaches a rejection handler to the poisoned queue tail (kernel.ts:483's
          // queue.then(task, task)), which is also why no unhandled rejection escapes.
          const cleanup = wallet.dataKeys.get("cleanup");

          // The kernel runs tasks in order: cleanup resolving proves the wedged task already ran
          // (and that the kernel is still alive — only that one response was lost).
          await expect(cleanup).resolves.toBeInstanceOf(Uint8Array);
          // (a) the kernel-side post threw the encoder's error for the first response only.
          expect(trap.postErrors).toHaveLength(1);
          expect(trap.postErrors[0]).toBeInstanceOf(CborError);
          expect((trap.postErrors[0] as CborError).code).toBe("lone-surrogate");
          // (b) the host promise for the wedged call is still pending 3 s later — no response
          // ever reached the channel.
          await vi.advanceTimersByTimeAsync(3_000);
          expect(wedgedSettled).toBe(false);
          // (c) at the 60 s watchdog deadline the call rejects "crashed" and the session is lost.
          await vi.advanceTimersByTimeAsync(57_000);
          await expect(wedged).rejects.toThrow(
            expect.objectContaining({ code: "crashed" }) as unknown as Error,
          );
          await vi.advanceTimersByTimeAsync(0); // let the respawned kernel report its status
          expect(wallet.getSnapshot().lockReason).toBe("crashed");
          expect(wallet.getSnapshot().vault).toBe("locked");
          // The next task handled the poisoned queue tail — nothing escaped unhandled.
          expect(unhandled).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      } finally {
        await wallet.destroy();
      }
    } finally {
      process.off("unhandledRejection", collector);
    }
  });
});
