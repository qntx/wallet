import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent, getPublicKey, KeysSigner } from "@qntx/nostr";
import type { Event, UnsignedEvent } from "@qntx/nostr";

import { Channel } from "../src/channel.ts";
import type { MainPort, PortExit, SetTimer } from "../src/channel.ts";
import { PASSKEY_PURPOSE_VAULT, PASSKEY_PURPOSE_WALLET } from "../src/factors.ts";
import type { PasskeyCeremony, PrfResult } from "../src/factors.ts";
import { nostr } from "../src/nostr/index.ts";
import type { ProtocolValue } from "../src/protocol/index.ts";
import { WalletError } from "../src/types.ts";
import type {
  LockReason,
  NostrKeyInfo,
  PasskeyConfig,
  StatusPayload,
  WalletErrorCode,
} from "../src/types.ts";
import { connectKernel } from "../src/wallet.ts";

const SECRET_KEY = hexToBytes("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const PUBLIC_KEY = getPublicKey(SECRET_KEY);
const SIGNER = new KeysSigner(SECRET_KEY);
const FORGED_SECRET = hexToBytes(
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const FORGED_PUBLIC_KEY = getPublicKey(FORGED_SECRET);
const FORGED_SIGNER = new KeysSigner(FORGED_SECRET);

const NOSTR_KEY: NostrKeyInfo = {
  ref: { kind: "derived", walletId: "0123456789abcdef", index: 0 },
  publicKey: PUBLIC_KEY,
  createdAt: 1,
};

export const PASSKEY = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};

type Request = {
  readonly id: number;
  readonly method: string;
  readonly session?: string;
  readonly params: ProtocolValue;
};

type Reply =
  | { readonly ok: ProtocolValue }
  | {
      readonly err: {
        readonly code: WalletErrorCode;
        readonly detail?: string;
      };
    };

type Handler = (request: Request) => Reply | Promise<Reply>;

/**
 * A scripted kernel stand-in. Each spawned port delivers the current status on attach; requests are
 * routed through `handlers` (missing handler → err "integrity", like a confused peer would).
 */
export class FakeKernel {
  status: StatusPayload;
  readonly handlers: Map<string, Handler> = new Map<string, Handler>();
  /** Every request method that reached the kernel, in order. */
  readonly received: string[] = [];
  private active: ScriptedPort | undefined;

  constructor(status: StatusPayload) {
    this.status = status;
    this.handlers.set("status", () => ({ ok: this.status }));
    // Real-kernel flow: the unlock response carries the session the deferred status waits for.
    this.handlers.set("vault.unlock", () => {
      this.status = { ...this.status, vault: "unlocked" };
      this.pushStatus();
      return { ok: { session: "0a".repeat(16) } };
    });
  }

  attach(port: ScriptedPort): void {
    this.active = port;
    // A real kernel delivers its first status asynchronously (the worker has to boot).
    setTimeout(() => {
      port.send({ v: 2, event: "status", status: this.status });
    });
  }

  detach(port: ScriptedPort): void {
    if (this.active === port) {
      this.active = undefined;
    }
  }

  receive(port: ScriptedPort, request: Request): void {
    this.received.push(request.method);
    const handler = this.handlers.get(request.method);
    const respond = (reply: Reply): void => {
      port.send({ v: 2, id: request.id, ...reply });
    };
    if (handler === undefined) {
      respond({ err: { code: "integrity" } });
      return;
    }
    void Promise.resolve(handler(request)).then(respond);
  }

  lock(reason: LockReason): void {
    this.status = { ...this.status, vault: "locked" };
    this.active?.send({ v: 2, event: "locked", reason });
    this.active?.send({ v: 2, event: "status", status: this.status });
  }

  pushStatus(): void {
    this.active?.send({ v: 2, event: "status", status: this.status });
  }

  /** A raw kernel → host message (e.g. the trailing locked event of an in-request lock). */
  send(message: unknown): void {
    this.active?.send(message);
  }
}

export class ScriptedPort implements MainPort {
  dead = false;
  private readonly kernel: FakeKernel;
  private handler: ((message: unknown) => void) | undefined;
  private exitHandler: ((reason: PortExit) => void) | undefined;

  constructor(kernel: FakeKernel) {
    this.kernel = kernel;
  }

  post(message: ProtocolValue): void {
    if (this.dead) {
      return;
    }
    this.kernel.receive(this, message as Request);
  }

  listen(handler: (message: unknown) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  onExit(handler: (reason: PortExit) => void): () => void {
    this.exitHandler = handler;
    return () => {
      this.exitHandler = undefined;
    };
  }

  terminate(): void {
    this.dead = true;
    this.kernel.detach(this);
    this.exitHandler?.("crashed");
  }

  send(message: unknown): void {
    this.handler?.(message);
  }

  /** A crash: exits without terminate having been called. */
  crash(): void {
    this.die("crashed");
  }

  /** A host-side platform lock (native background expiry): still the port's one exit. */
  background(): void {
    this.die("background");
  }

  private die(reason: PortExit): void {
    this.dead = true;
    this.kernel.detach(this);
    this.exitHandler?.(reason);
  }
}

export function unlockedStatus(): StatusPayload {
  return {
    protocol: 2,
    vault: "unlocked",
    factors: [{ kind: "passkey", id: "f".repeat(32), credentialId: "Y3JlZA", createdAt: 1 }],
    wallets: [],
    nostr: { keys: [NOSTR_KEY] },
    importedKeys: [],
    backup: null,
  };
}

/**
 * Manually-fired timers for the channel's per-call timeout: `fireAll` runs every armed timer as if
 * its deadline had passed. The fake kernel's status delivery still uses a real `setTimeout`.
 */
class FakeTimers {
  private next = 0;
  private readonly timers = new Map<number, { fn: () => void; cancelled: boolean }>();

  readonly setTimer: SetTimer = (_delayMs, fn) => {
    const id = ++this.next;
    this.timers.set(id, { fn, cancelled: false });
    return () => {
      const entry = this.timers.get(id);
      if (entry !== undefined) {
        entry.cancelled = true;
      }
    };
  };

  /** How many timers are armed right now (the channel keeps at most one watchdog). */
  get armed(): number {
    let count = 0;
    for (const entry of this.timers.values()) {
      if (!entry.cancelled) {
        count++;
      }
    }
    return count;
  }

  fireAll(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const entry of pending) {
      if (!entry.cancelled) {
        entry.fn();
      }
    }
  }
}

const realtime: SetTimer = (delayMs, fn) => {
  const timer = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

async function connectFake(
  status: StatusPayload,
  setTimer: SetTimer = realtime,
  presence?: (onActivity: () => void) => () => void,
  verify: (event: Event) => boolean = verifyEvent,
): Promise<{
  wallet: Awaited<ReturnType<typeof connectKernel>>;
  kernel: FakeKernel;
  spawned: ScriptedPort[];
}> {
  const kernel = new FakeKernel(
    status.vault === "unlocked" ? { ...status, vault: "locked" } : status,
  );
  const spawned: ScriptedPort[] = [];
  const wallet = await connectKernel({
    verifyEvent: verify,
    spawn: () => {
      const port = new ScriptedPort(kernel);
      spawned.push(port);
      kernel.attach(port);
      return port;
    },
    factors: "software",
    passkey: PASSKEY,
    ceremony: undefined,
    setTimer,
    ...(presence === undefined ? {} : { presence }),
  });
  if (status.vault === "unlocked") {
    // The fixture models an already-unlocked kernel — drive a real unlock so the host installs
    // the session and the deferred status event reaches subscribers, like a live kernel.
    await wallet.vault.unlock({ kind: "password", password: "long enough password" });
  }
  return { wallet, kernel, spawned };
}

export function walletError(error: unknown): WalletError {
  if (!(error instanceof WalletError)) {
    throw error;
  }
  return error;
}

describe("channel status ordering", () => {
  it("holds an unlocked status until the session is installed", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    const statuses: StatusPayload[] = [];
    const channel = new Channel(
      () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      {
        onStatus: (s) => {
          statuses.push(s);
        },
        onLocked: () => {},
        onCrashed: () => {},
      },
      setTimeout as unknown as SetTimer,
    );
    await channel.start();
    // The attach status says unlocked but no session exists — subscribers must not see it.
    expect(statuses).toHaveLength(0);
    channel.session = "0a".repeat(16);
    channel.flushStatus();
    expect(statuses.map((s) => s.vault)).toStrictEqual(["unlocked"]);
    channel.destroy();
  });

  it("delivers an unlocked status at once when the session is already installed", async () => {
    const kernel = new FakeKernel({ ...unlockedStatus(), vault: "locked" });
    const statuses: StatusPayload[] = [];
    const channel = new Channel(
      () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      {
        onStatus: (s) => {
          statuses.push(s);
        },
        onLocked: () => {},
        onCrashed: () => {},
      },
      setTimeout as unknown as SetTimer,
    );
    await channel.start();
    // Response-first order: the session is installed before the status event arrives.
    channel.session = "0a".repeat(16);
    kernel.status = { ...kernel.status, vault: "unlocked" };
    kernel.pushStatus();
    expect(statuses.map((s) => s.vault)).toStrictEqual(["locked", "unlocked"]);
    channel.destroy();
  });
});

describe("response validation", () => {
  it("rejects an invalid ok payload with integrity and breaks the wallet", async () => {
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus());
    kernel.handlers.set("dataKeys.get", () => ({ ok: "not-bytes" }));
    await expect(wallet.dataKeys.get("notes")).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
    // A kernel that answers off-schema is untrustworthy: terminal state, no respawn.
    expect(spawned).toHaveLength(1);
    expect(spawned.at(0)?.dead).toBe(true);
    await expect(wallet.dataKeys.get("notes")).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("carries an error detail from the kernel to WalletError", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("dataKeys.get", () => ({
      err: { code: "unavailable", detail: "android:KeyPermanentlyInvalidatedException" },
    }));
    await expect(wallet.dataKeys.get("notes")).rejects.toThrow(
      expect.objectContaining({
        code: "unavailable",
        detail: "android:KeyPermanentlyInvalidatedException",
      }),
    );
  });

  it("drops an error that carries a malformed detail", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("dataKeys.get", () => ({
      err: { code: "unavailable", detail: "free text, not a token" },
    }));
    await expect(wallet.dataKeys.get("notes")).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("rejects a forged kernel signature with integrity", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("nostr.signEvent", () => ({
      ok: {
        id: "0".repeat(64),
        pubkey: PUBLIC_KEY,
        sig: "0".repeat(128),
        kind: 1,
        created_at: 1,
        tags: [],
        content: "forged",
      },
    }));
    const signer = nostr(wallet).signer(NOSTR_KEY.ref);
    await expect(
      signer.signEvent({ kind: 1, created_at: 1, tags: [], content: "x", pubkey: PUBLIC_KEY }),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  it("rejects a valid signature over different content with integrity", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    // A compromised kernel signs honestly but swaps the content/tags — still forged.
    kernel.handlers.set("nostr.signEvent", async () => ({
      ok: await SIGNER.signEvent({
        pubkey: PUBLIC_KEY,
        kind: 1,
        created_at: 1,
        tags: [],
        content: "different",
      }),
    }));
    const signer = nostr(wallet).signer(NOSTR_KEY.ref);
    await expect(
      signer.signEvent({ kind: 1, created_at: 1, tags: [], content: "x", pubkey: PUBLIC_KEY }),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  it("verifies each signed event exactly once with the injected verifier", async () => {
    const seen: Event[] = [];
    const { wallet, kernel } = await connectFake(unlockedStatus(), realtime, undefined, (event) => {
      seen.push(event);
      return verifyEvent(event);
    });
    const unsigned = { kind: 1, created_at: 1, tags: [], content: "x", pubkey: PUBLIC_KEY };
    kernel.handlers.set("nostr.signEvent", async () => ({ ok: await SIGNER.signEvent(unsigned) }));
    const signed = await nostr(wallet).signer(NOSTR_KEY.ref).signEvent(unsigned);
    expect(seen).toStrictEqual([signed]);
  });

  it("rejects with integrity when the injected verifier refuses the event", async () => {
    const { wallet, kernel } = await connectFake(
      unlockedStatus(),
      realtime,
      undefined,
      () => false,
    );
    const unsigned = { kind: 1, created_at: 1, tags: [], content: "x", pubkey: PUBLIC_KEY };
    kernel.handlers.set("nostr.signEvent", async () => ({ ok: await SIGNER.signEvent(unsigned) }));
    await expect(nostr(wallet).signer(NOSTR_KEY.ref).signEvent(unsigned)).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("fails pending calls on an unattributed response and breaks the wallet", async () => {
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus());
    kernel.handlers.set("dataKeys.get", async () => new Promise<Reply>(() => undefined)); // never resolves
    const snapshot = wallet.getSnapshot();
    const pending = wallet.dataKeys.get("notes");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    }); // let the request reach the kernel
    spawned.at(0)?.send({ v: 2, id: 0, ok: null }); // UNATTRIBUTED_ID — cannot be a live request
    await expect(pending).rejects.toSatisfy((e) => walletError(e).code === "integrity");
    // Poison is terminal: the port is terminated, nothing respawns, every later call fails
    // integrity, and the snapshot is untouched.
    expect(spawned).toHaveLength(1);
    expect(spawned.at(0)?.dead).toBe(true);
    await expect(wallet.dataKeys.get("notes")).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
    await expect(wallet.vault.reset()).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
    expect(wallet.getSnapshot()).toBe(snapshot);
  });
});

describe("port lifecycle", () => {
  it("fails pending requests with crashed on port exit and respawns", async () => {
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus());
    kernel.status = { ...kernel.status, vault: "locked" }; // a crashed kernel reloads locked
    kernel.handlers.set("dataKeys.get", async () => new Promise<Reply>(() => undefined)); // never resolves
    const pending = wallet.dataKeys.get("notes");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    }); // let the request reach the kernel
    spawned.at(0)?.crash();
    await expect(pending).rejects.toSatisfy((e) => walletError(e).code === "crashed");
    expect(spawned).toHaveLength(2);
    kernel.handlers.set("dataKeys.get", () => ({ err: { code: "locked" } })); // respawned kernel is locked
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(wallet.getSnapshot().vault).toBe("locked");
    expect(wallet.getSnapshot().lockReason).toBe("crashed");
    expect(spawned.at(0)?.dead).toBe(true);
  });

  it("a background exit takes the lock path: locked code, background reason, respawn", async () => {
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus());
    kernel.status = { ...kernel.status, vault: "locked" }; // the host locked — a fresh kernel reloads locked
    kernel.handlers.set("dataKeys.get", async () => new Promise<Reply>(() => undefined)); // never resolves
    const pending = wallet.dataKeys.get("notes");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    }); // let the request reach the kernel
    spawned.at(0)?.background();
    await expect(pending).rejects.toSatisfy((e) => walletError(e).code === "locked");
    expect(spawned).toHaveLength(2);
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(wallet.getSnapshot().vault).toBe("locked");
    expect(wallet.getSnapshot().lockReason).toBe("background");
  });

  it("a background exit before the first status still rejects with integrity", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    const spawned: ScriptedPort[] = [];
    const attempt = connectKernel({
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        spawned.push(port);
        setTimeout(() => {
          port.background(); // the platform lock can never come before the kernel ran honestly
        });
        return port;
      },
      factors: "software",
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: realtime,
    });
    await expect(attempt).rejects.toSatisfy((e) => walletError(e).code === "integrity");
    expect(spawned).toHaveLength(1);
  });

  it("a respawned port that dies before its first status breaks the wallet", async () => {
    const { wallet, spawned } = await connectFake(unlockedStatus());
    spawned.at(0)?.crash(); // proven port → respawn begins
    const second = spawned.at(1);
    expect(second).toBeDefined();
    second?.crash(); // dies before delivering any status — terminal
    await expect(wallet.dataKeys.get("notes")).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
    expect(spawned).toHaveLength(2);
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    }); // a stray status from the dead port must not resurrect anything
    expect(spawned).toHaveLength(2);
  });

  it("keeps the snapshot and respawns when the kernel emits a locked event", async () => {
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus());
    kernel.handlers.set("dataKeys.get", () => ({ ok: new Uint8Array(32) }));
    kernel.lock("idle");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(spawned).toHaveLength(2);
    expect(spawned.at(0)?.dead).toBe(true);
    const snapshot = wallet.getSnapshot();
    expect(snapshot.vault).toBe("locked");
    expect(snapshot.lockReason).toBe("idle");
    expect(snapshot.nostr.keys.at(0)?.publicKey).toBe(PUBLIC_KEY);

    // The fresh kernel answers session methods with "locked".
    kernel.handlers.set("dataKeys.get", () => ({ err: { code: "locked" } }));
    await expect(wallet.dataKeys.get("notes")).rejects.toSatisfy(
      (e) => walletError(e).code === "locked",
    );
  });
});

describe("connect lifecycle", () => {
  it("rejects connect with integrity on a protocol version mismatch, spawning once", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    const spawned: ScriptedPort[] = [];
    const attempt = connectKernel({
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        spawned.push(port);
        // A kernel speaking a different protocol version: the status event fails validation.
        setTimeout(() => {
          port.send({
            v: 2,
            event: "status",
            status: { ...kernel.status, protocol: 1 },
          });
        });
        return port;
      },
      factors: "software",
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: realtime,
    });
    await expect(attempt).rejects.toSatisfy((e) => walletError(e).code === "integrity");
    expect(spawned).toHaveLength(1);
    expect(spawned.at(0)?.dead).toBe(true);
  });

  it("rejects connect with integrity when the port dies before its first status", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    const spawned: ScriptedPort[] = [];
    const attempt = connectKernel({
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        spawned.push(port);
        setTimeout(() => {
          port.crash(); // e.g. the worker script blocked by CSP — no status ever arrives
        });
        return port;
      },
      factors: "software",
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: realtime,
    });
    await expect(attempt).rejects.toSatisfy((e) => walletError(e).code === "integrity");
    expect(spawned).toHaveLength(1);
  });
});

describe("sync signer", () => {
  const SYNC_WALLET = "0123456789abcdef";

  const connect = async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("nostr.syncKey", () => ({ ok: { publicKey: PUBLIC_KEY } }));
    return { wallet, kernel };
  };

  it("getPublicKey calls nostr.syncKey once and memoizes", async () => {
    const { wallet, kernel } = await connect();
    const signer = nostr(wallet).syncSigner(SYNC_WALLET);
    const calls: number[] = [];
    kernel.handlers.set("nostr.syncKey", () => {
      calls.push(1);
      return { ok: { publicKey: PUBLIC_KEY } };
    });
    await expect(signer.getPublicKey()).resolves.toBe(PUBLIC_KEY);
    await expect(signer.getPublicKey()).resolves.toBe(PUBLIC_KEY);
    expect(calls).toHaveLength(1);
    expect(kernel.received.filter((m) => m.startsWith("nostr."))).toStrictEqual(["nostr.syncKey"]);
  });

  it("signEvent sends nostr.syncSign and returns the signed event", async () => {
    const { wallet, kernel } = await connect();
    kernel.handlers.set("nostr.syncSign", async (request) => {
      const params = request.params as {
        walletId: string;
        event: { kind: number; created_at: number; tags: string[][]; content: string };
      };
      expect(params.walletId).toBe(SYNC_WALLET);
      expect(params.event.kind).toBe(30078);
      const unsigned: UnsignedEvent = {
        pubkey: PUBLIC_KEY,
        kind: params.event.kind,
        created_at: params.event.created_at,
        tags: params.event.tags,
        content: params.event.content,
      };
      return { ok: await SIGNER.signEvent(unsigned) };
    });
    const signer = nostr(wallet).syncSigner(SYNC_WALLET);
    const signed = await signer.signEvent({
      kind: 30078,
      created_at: 1767225600,
      tags: [["d", "metadata"]],
      content: '{"v":2}',
      pubkey: "",
    });
    expect(signed.pubkey).toBe(PUBLIC_KEY);
    expect(signed.kind).toBe(30078);
    expect(kernel.received.filter((m) => m.startsWith("nostr."))).toStrictEqual([
      "nostr.syncKey",
      "nostr.syncSign",
    ]);
  });

  it("rejects a forged pubkey from the kernel with integrity", async () => {
    const { wallet, kernel } = await connect();
    kernel.handlers.set("nostr.syncSign", async () => {
      // The kernel signs honestly but with a different key — the returned pubkey is not the sync
      // key, so the host's forged-event check rejects it.
      const unsigned: UnsignedEvent = {
        pubkey: FORGED_PUBLIC_KEY,
        kind: 30078,
        created_at: 1767225600,
        tags: [],
        content: '{"v":2}',
      };
      return { ok: await FORGED_SIGNER.signEvent(unsigned) };
    });
    const signer = nostr(wallet).syncSigner(SYNC_WALLET);
    await expect(
      signer.signEvent({
        kind: 30078,
        created_at: 1767225600,
        tags: [],
        content: '{"v":2}',
        pubkey: "",
      }),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  it("rejects a valid signature over different content with integrity", async () => {
    const { wallet, kernel } = await connect();
    kernel.handlers.set("nostr.syncSign", async () => {
      const unsigned: UnsignedEvent = {
        pubkey: PUBLIC_KEY,
        kind: 30078,
        created_at: 1767225600,
        tags: [],
        content: "forged metadata",
      };
      return { ok: await SIGNER.signEvent(unsigned) };
    });
    const signer = nostr(wallet).syncSigner(SYNC_WALLET);
    await expect(
      signer.signEvent({
        kind: 30078,
        created_at: 1767225600,
        tags: [],
        content: '{"v":2}',
        pubkey: "",
      }),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  it("rejects a malformed signature with integrity", async () => {
    const { wallet, kernel } = await connect();
    kernel.handlers.set("nostr.syncSign", () => ({
      ok: {
        id: "e".repeat(64),
        pubkey: PUBLIC_KEY,
        sig: "00".repeat(64),
        kind: 30078,
        created_at: 1767225600,
        tags: [],
        content: '{"v":2}',
      },
    }));
    const signer = nostr(wallet).syncSigner(SYNC_WALLET);
    await expect(
      signer.signEvent({
        kind: 30078,
        created_at: 1767225600,
        tags: [],
        content: '{"v":2}',
        pubkey: "",
      }),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  it("encrypt and decrypt forward { walletId, text }", async () => {
    const { wallet, kernel } = await connect();
    const seen: string[] = [];
    kernel.handlers.set("nostr.syncEncrypt", (request) => {
      const params = request.params as { walletId: string; text: string };
      seen.push(`enc:${params.walletId}:${params.text}`);
      return { ok: `payload:${params.text}` };
    });
    kernel.handlers.set("nostr.syncDecrypt", (request) => {
      const params = request.params as { walletId: string; text: string };
      seen.push(`dec:${params.walletId}:${params.text}`);
      return { ok: params.text.replace("payload:", "") };
    });
    const signer = nostr(wallet).syncSigner(SYNC_WALLET);
    await expect(signer.encrypt("clear")).resolves.toBe("payload:clear");
    await expect(signer.decrypt("payload:clear")).resolves.toBe("clear");
    expect(seen).toStrictEqual([`enc:${SYNC_WALLET}:clear`, `dec:${SYNC_WALLET}:payload:clear`]);
    expect(kernel.received.filter((m) => m.startsWith("nostr."))).toStrictEqual([
      "nostr.syncEncrypt",
      "nostr.syncDecrypt",
    ]);
  });
});
describe("proxy signer", () => {
  it("survives lock/unlock and verifies real signatures", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    const realSign: Handler = async (request) => {
      const params = request.params as {
        publicKey: string;
        event: { kind: number; created_at: number; tags: string[][]; content: string };
      };
      const unsigned: UnsignedEvent = {
        pubkey: params.publicKey,
        kind: params.event.kind,
        created_at: params.event.created_at,
        tags: params.event.tags,
        content: params.event.content,
      };
      return { ok: await SIGNER.signEvent(unsigned) };
    };
    kernel.handlers.set("nostr.signEvent", realSign);
    kernel.handlers.set("vault.unlock", () => {
      kernel.status = { ...kernel.status, vault: "unlocked" };
      kernel.pushStatus();
      return { ok: { session: "0a".repeat(16) } };
    });

    const signer = nostr(wallet).signer(NOSTR_KEY.ref);
    await expect(signer.getPublicKey()).resolves.toBe(PUBLIC_KEY);
    const signed = await signer.signEvent({
      kind: 1,
      created_at: 100,
      tags: [],
      content: "hello",
      pubkey: PUBLIC_KEY,
    });
    expect(signed.pubkey).toBe(PUBLIC_KEY);

    kernel.lock("user");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(wallet.getSnapshot().vault).toBe("locked");

    // Locked: the kernel's error maps to WalletError locked.
    kernel.handlers.set("nostr.signEvent", () => ({ err: { code: "locked" } }));
    await expect(
      signer.signEvent({ kind: 1, created_at: 1, tags: [], content: "x", pubkey: PUBLIC_KEY }),
    ).rejects.toSatisfy((e) => walletError(e).code === "locked");

    // After unlock the same proxy object works again — resolution is per call.
    kernel.handlers.set("nostr.signEvent", realSign);
    await wallet.vault.unlock({ kind: "password", password: "long enough password" });
    expect(wallet.getSnapshot().vault).toBe("unlocked");
    const again = await signer.signEvent({
      kind: 1,
      created_at: 101,
      tags: [],
      content: "back",
      pubkey: PUBLIC_KEY,
    });
    expect(again.pubkey).toBe(PUBLIC_KEY);
  });
});

describe("host-side lock", () => {
  it("lock resolves without a kernel reply, fails pending calls, and respawns the port", async () => {
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus());
    kernel.status = { ...kernel.status, vault: "locked" }; // the respawned kernel reloads locked
    kernel.handlers.set("dataKeys.get", async () => new Promise<Reply>(() => undefined)); // silent
    const pending = wallet.dataKeys.get("notes");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    }); // let the request reach the kernel
    // No kernel round trip: lock resolves immediately even though the kernel never answers.
    await wallet.vault.lock();
    await expect(pending).rejects.toSatisfy((e) => walletError(e).code === "locked");
    expect(spawned).toHaveLength(2);
    expect(spawned.at(0)?.dead).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    }); // the fresh port's initial status
    expect(wallet.getSnapshot().vault).toBe("locked");
    expect(wallet.getSnapshot().lockReason).toBe("user");
  });

  it("lock on an uninitialized vault leaves the snapshot uninitialized", async () => {
    const { wallet } = await connectFake({ ...unlockedStatus(), vault: "uninitialized" });
    await wallet.vault.lock();
    expect(wallet.getSnapshot().vault).toBe("uninitialized");
  });

  it("lock on a corrupted vault keeps the kernel's verdict", async () => {
    const { wallet } = await connectFake({ ...unlockedStatus(), vault: "corrupted" });
    await wallet.vault.lock();
    expect(wallet.getSnapshot().vault).toBe("corrupted");
    expect(wallet.getSnapshot().lockReason).toBe("user");
  });

  it("a call that never gets an answer times out as crashed and respawns", async () => {
    const timers = new FakeTimers();
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus(), timers.setTimer);
    kernel.status = { ...kernel.status, vault: "locked" };
    kernel.handlers.set("dataKeys.get", async () => new Promise<Reply>(() => undefined)); // silent
    const pending = wallet.dataKeys.get("notes");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    }); // let the request reach the kernel; its timeout timer is armed
    timers.fireAll();
    await expect(pending).rejects.toSatisfy((e) => walletError(e).code === "crashed");
    expect(spawned).toHaveLength(2);
    expect(spawned.at(0)?.dead).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(wallet.getSnapshot().vault).toBe("locked");
    expect(wallet.getSnapshot().lockReason).toBe("crashed");
  });
});

describe("message ordering", () => {
  it("resolves vault.reset while unlocked; the snapshot ends uninitialized", async () => {
    const { wallet, kernel, spawned } = await connectFake(unlockedStatus());
    kernel.handlers.set("vault.reset", () => {
      kernel.status = { ...kernel.status, vault: "uninitialized" };
      kernel.pushStatus();
      setTimeout(() => {
        kernel.send({ v: 2, event: "locked", reason: "user" });
      });
      return { ok: null };
    });
    await wallet.vault.reset();
    expect(wallet.getSnapshot().vault).toBe("uninitialized");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(spawned).toHaveLength(2);
  });
});

describe("snapshot", () => {
  it("works unbound: getSnapshot and subscribe detach from the wallet object", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    // useSyncExternalStore(wallet.subscribe, wallet.getSnapshot) calls them unbound.
    const { getSnapshot, subscribe } = wallet;
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls++;
    });
    expect(getSnapshot().vault).toBe("unlocked");
    kernel.status = { ...kernel.status, vault: "locked" };
    kernel.pushStatus();
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(calls).toBe(1);
    expect(getSnapshot().vault).toBe("locked");
    unsubscribe();
  });

  it("notifies subscribers only when the snapshot actually changes", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    let calls = 0;
    wallet.subscribe(() => {
      calls++;
    });
    const first = wallet.getSnapshot();
    kernel.pushStatus(); // identical payload → no new snapshot
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(calls).toBe(0);
    expect(wallet.getSnapshot()).toBe(first);

    kernel.status = { ...kernel.status, vault: "locked" };
    kernel.pushStatus();
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    expect(calls).toBe(1);
    expect(wallet.getSnapshot()).not.toBe(first);
    expect(wallet.getSnapshot().vault).toBe("locked");
  });
});

describe("nostr module factory", () => {
  it("returns the same object for the same wallet and rejects foreign objects", async () => {
    const { wallet } = await connectFake(unlockedStatus());
    const first = nostr(wallet);
    expect(nostr(wallet)).toBe(first);
    expect(() => nostr({ ...wallet })).toThrow(WalletError);
    expect(() => nostr({} as Parameters<typeof nostr>[0])).toThrow(
      expect.objectContaining({ code: "invalid-input" }) as WalletError,
    );
  });
});

describe("ExportedSecret", () => {
  it("reads exactly once and wipes", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    const secret = utf8ToBytes("abandon abandon abandon");
    kernel.handlers.set("wallet.exportMnemonic", () => ({
      ok: { mnemonic: new Uint8Array(secret) },
    }));
    const verify = { kind: "password" as const, password: "long enough password" };
    const exported = await wallet.wallets.exportMnemonic("0".repeat(16), verify);
    const bytes = exported.mnemonic.read();
    expect(new TextDecoder().decode(bytes)).toBe("abandon abandon abandon");
    expect(() => exported.mnemonic.read()).toThrow(WalletError);
    expect(exported.passphrase).toBeUndefined();
    exported.mnemonic.wipe();
  });

  it("exports the passphrase of a passphrase wallet as its own one-shot secret", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("wallet.exportMnemonic", () => ({
      ok: { mnemonic: utf8ToBytes("abandon abandon abandon"), passphrase: utf8ToBytes("p4ss") },
    }));
    const verify = { kind: "password" as const, password: "long enough password" };
    const exported = await wallet.wallets.exportMnemonic("0".repeat(16), verify);
    expect(new TextDecoder().decode(exported.passphrase?.read())).toBe("p4ss");
    expect(() => exported.passphrase?.read()).toThrow(WalletError);
  });
});

const PASSPHRASE_WALLET = {
  walletId: "0123456789abcdef",
  origin: "mnemonic",
  words: 12,
  backup: "mnemonic",
  passphrase: true,
  createdAt: 1,
} as const;
const SESSION_ID = "ab".repeat(16);

const sentPassphrase = (params: Record<string, unknown> | undefined): boolean =>
  params !== undefined && "passphrase" in params;

describe("BIP-39 passphrase wire", () => {
  const text = (bytes: unknown): string => new TextDecoder().decode(bytes as Uint8Array);

  it("importMnemonic sends the passphrase as UTF-8 bytes and omits it when empty", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    const seen: Array<Record<string, unknown>> = [];
    kernel.handlers.set("wallet.importMnemonic", (request) => {
      seen.push(request.params as Record<string, unknown>);
      return { ok: { wallet: PASSPHRASE_WALLET, session: SESSION_ID } };
    });
    const imported = await wallet.wallets.importMnemonic({
      mnemonic: "abandon abandon abandon",
      passphrase: "p\u00E4ss word",
    });
    expect(imported.passphrase).toBe(true);
    expect(text(seen[0]?.["passphrase"])).toBe("p\u00E4ss word");

    await wallet.wallets.importMnemonic({ mnemonic: "abandon", passphrase: "" });
    await wallet.wallets.importMnemonic({ mnemonic: "abandon" });
    expect(sentPassphrase(seen[1])).toBe(false);
    expect(sentPassphrase(seen[2])).toBe(false);
  });

  it("confirm sends the passphrase with the quiz answers", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    let confirmParams: Record<string, unknown> = {};
    kernel.handlers.set("wallet.createMnemonic", () => ({
      ok: {
        draft: "cd".repeat(16),
        words: utf8ToBytes("abandon abandon abandon"),
        quiz: [0, 1, 2],
      },
    }));
    kernel.handlers.set("wallet.confirmMnemonic", (request) => {
      confirmParams = request.params as Record<string, unknown>;
      return { ok: { wallet: PASSPHRASE_WALLET, session: SESSION_ID } };
    });
    const draft = await wallet.wallets.createMnemonic({ words: 12 });
    const confirmed = await draft.confirm(["a", "b", "c"], { passphrase: "secret" });
    expect(confirmed.passphrase).toBe(true);
    expect(text(confirmParams["passphrase"])).toBe("secret");

    await draft.confirm(["a", "b", "c"]);
    expect("passphrase" in confirmParams).toBe(false);
  });

  it("restore sends passphrases and returns the wallets still needing one", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    let restoreParams: Record<string, unknown> = {};
    kernel.handlers.set("backup.restore", (request) => {
      restoreParams = request.params as Record<string, unknown>;
      return {
        ok: {
          wallets: [],
          passphraseRequired: ["0123456789abcdef"],
          session: SESSION_ID,
        },
      };
    });
    const result = await wallet.backup.restore({
      envelope: "{}",
      backupFactor: { kind: "password", password: "long enough password" },
      passphrases: [{ walletId: "0123456789abcdef", passphrase: "secret" }],
    });
    expect(result.passphraseRequired).toStrictEqual(["0123456789abcdef"]);
    expect(result.wallets).toStrictEqual([]);
    const sent = restoreParams["passphrases"] as Array<{ walletId: string; passphrase: unknown }>;
    expect(sent[0]?.walletId).toBe("0123456789abcdef");
    expect(text(sent[0]?.passphrase)).toBe("secret");
  });
});

describe("request size cap", () => {
  const event = (content: string): UnsignedEvent => ({
    pubkey: PUBLIC_KEY,
    kind: 1,
    created_at: 1,
    tags: [],
    content,
  });

  it("rejects an over-cap request with invalid-input and posts nothing", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("nostr.signEvent", async () => ({
      ok: await SIGNER.signEvent(event("x")),
    }));
    const signer = nostr(wallet).signer(NOSTR_KEY.ref);
    // 400k UTF-16 units measure 1.2 MB against the 1 MiB cap — the request never posts.
    await expect(
      signer.signEvent({ ...event("x".repeat(400_000)), pubkey: PUBLIC_KEY }),
    ).rejects.toSatisfy((e) => walletError(e).code === "invalid-input");
    expect(kernel.received).not.toContain("nostr.signEvent");
  });

  it("posts a just-under-cap request", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("nostr.signEvent", async (request) => {
      const params = request.params as { publicKey: string; event: UnsignedEvent };
      return { ok: await SIGNER.signEvent({ ...params.event, pubkey: params.publicKey }) };
    });
    const signer = nostr(wallet).signer(NOSTR_KEY.ref);
    // MAX_TEXT chars measure ~786 kB — under the cap — so the kernel sees the request.
    const signed = await signer.signEvent({ ...event("x".repeat(262_144)), pubkey: PUBLIC_KEY });
    expect(signed.pubkey).toBe(PUBLIC_KEY);
    expect(kernel.received).toContain("nostr.signEvent");
  });
});

describe("passkey restore purpose", () => {
  function ceremonyWith(userHandle: Uint8Array | undefined): {
    ceremony: PasskeyCeremony;
    result: PrfResult;
  } {
    const result: PrfResult = {
      credentialId: utf8ToBytes("credential-1"),
      first: new Uint8Array(32).fill(7),
      second: new Uint8Array(32).fill(8),
      synced: true,
      ...(userHandle === undefined ? {} : { userHandle }),
    };
    return {
      result,
      ceremony: {
        // oxlint-disable-next-line typescript/require-await -- the ceremony contract is async
        create: async () => result,
        // oxlint-disable-next-line typescript/require-await -- the ceremony contract is async
        assert: async () => result,
      },
    };
  }

  async function connectWithCeremony(ceremony: PasskeyCeremony): Promise<{
    wallet: Awaited<ReturnType<typeof connectKernel>>;
    kernel: FakeKernel;
  }> {
    const kernel = new FakeKernel({ ...unlockedStatus(), vault: "uninitialized" });
    const wallet = await connectKernel({
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      factors: "software",
      passkey: PASSKEY,
      ceremony,
      setTimer: realtime,
    });
    return { wallet, kernel };
  }

  it("rejects a vault-purpose credential, wipes the PRF and posts nothing", async () => {
    const handle = new Uint8Array(16);
    handle[0] = PASSKEY_PURPOSE_VAULT;
    const { ceremony, result } = ceremonyWith(handle);
    const { wallet, kernel } = await connectWithCeremony(ceremony);
    await expect(wallet.wallets.restoreWithPasskey()).rejects.toSatisfy(
      (e) => walletError(e).code === "wrong-passkey",
    );
    expect(kernel.received).not.toContain("wallet.restoreWithPasskey");
    expect(result.first.every((b) => b === 0)).toBe(true);
    expect(result.second?.every((b) => b === 0)).toBe(true);
  });

  it("rejects an assertion without a userHandle", async () => {
    const { ceremony, result } = ceremonyWith(undefined);
    const { wallet, kernel } = await connectWithCeremony(ceremony);
    await expect(wallet.wallets.restoreWithPasskey()).rejects.toSatisfy(
      (e) => walletError(e).code === "wrong-passkey",
    );
    expect(kernel.received).not.toContain("wallet.restoreWithPasskey");
    expect(result.first.every((b) => b === 0)).toBe(true);
  });

  it("restores with a wallet-purpose credential", async () => {
    const handle = new Uint8Array(16);
    handle[0] = PASSKEY_PURPOSE_WALLET;
    const { ceremony } = ceremonyWith(handle);
    const { wallet, kernel } = await connectWithCeremony(ceremony);
    kernel.handlers.set("wallet.restoreWithPasskey", () => ({
      ok: {
        wallet: {
          walletId: "0123456789abcdef",
          origin: "passkey",
          words: 12,
          backup: "passkey",
          passphrase: false,
          createdAt: 1,
        },
        session: "ab".repeat(16),
      },
    }));
    const restored = await wallet.wallets.restoreWithPasskey();
    expect(restored.walletId).toBe("0123456789abcdef");
    expect(kernel.received).toContain("wallet.restoreWithPasskey");
  });
});

describe("kernel-run passkey ceremonies (hardware host)", () => {
  it("sends the kernel ceremony shape with no PRF evidence and no host ceremony", async () => {
    const kernel = new FakeKernel({ ...unlockedStatus(), vault: "uninitialized" });
    const seen: ProtocolValue[] = [];
    kernel.handlers.set("wallet.createWithPasskey", (request) => {
      seen.push(request.params);
      return {
        ok: {
          wallet: {
            walletId: "0123456789abcdef",
            origin: "passkey",
            words: 12,
            backup: "passkey",
            passphrase: false,
            createdAt: 1,
          },
          session: "ab".repeat(16),
        },
      };
    });
    const wallet = await connectKernel({
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      factors: "hardware",
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: realtime,
    });
    await wallet.wallets.createWithPasskey({ name: " alice " });
    expect(seen).toStrictEqual([
      {
        ceremony: "kernel",
        rpId: PASSKEY.rpId,
        rpName: PASSKEY.rpName,
        name: "alice",
        walletSalt: PASSKEY.walletSalt,
        factor: { kind: "hardware" },
      },
    ]);
  });
});

describe("passkey config validation", () => {
  function connectWithPasskey(patch: Partial<PasskeyConfig>): {
    attempt: ReturnType<typeof connectKernel>;
    spawned: ScriptedPort[];
  } {
    const kernel = new FakeKernel(unlockedStatus());
    const spawned: ScriptedPort[] = [];
    const attempt = connectKernel({
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        spawned.push(port);
        kernel.attach(port);
        return port;
      },
      factors: "software",
      passkey: { ...PASSKEY, ...patch },
      ceremony: undefined,
      setTimer: realtime,
    });
    return { attempt, spawned };
  }

  it.each([
    { rpId: "" },
    { rpName: "" },
    { walletSalt: "" },
    { vaultSalt: "" },
    { vaultSalt: PASSKEY.walletSalt },
  ])("rejects %o with invalid-input before spawning", async (patch) => {
    const { attempt, spawned } = connectWithPasskey(patch);
    await expect(attempt).rejects.toSatisfy((e) => walletError(e).code === "invalid-input");
    expect(spawned).toHaveLength(0);
  });
});

describe("queue-head watchdog", () => {
  it("times only the head — a request queued behind a slow head gets a fresh clock", async () => {
    const timers = new FakeTimers();
    const { wallet, kernel } = await connectFake(unlockedStatus(), timers.setTimer);
    // The kernel answers in order: both calls wait on the test — "tail" must still be pending
    // when "head" settles, which is what being queued behind it means.
    const gates = new Map<string, () => void>();
    kernel.handlers.set("dataKeys.get", async (request) => {
      const params = request.params as { purpose: string };
      await new Promise<void>((resolve) => {
        gates.set(params.purpose, resolve);
      });
      return { ok: new Uint8Array(32) };
    });
    const head = wallet.dataKeys.get("head");
    const queued = wallet.dataKeys.get("tail");
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
    // Both requests reached the kernel, but only the earliest pending one is timed.
    expect(timers.armed).toBe(1);
    gates.get("head")?.(); // the head answers at the edge of its window
    await expect(head).resolves.toBeInstanceOf(Uint8Array);
    // The watchdog moved to the queued request, now the head — its clock started now.
    expect(timers.armed).toBe(1);
    gates.get("tail")?.();
    await expect(queued).resolves.toBeInstanceOf(Uint8Array);
    expect(timers.armed).toBe(0);
  });
});

describe("presence activity", () => {
  const unlockPassword = { kind: "password" as const, password: "long enough password" };

  function presenceKernel(kernel: FakeKernel): void {
    kernel.handlers.set("vault.unlock", () => ({ ok: { session: "ab".repeat(16) } }));
    kernel.handlers.set("session.touch", () => ({ ok: null }));
  }

  const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
  };

  it("throttles to one session.touch per interval and only while a session exists", async () => {
    const timers = new FakeTimers();
    let activity: (() => void) | undefined;
    const { wallet, kernel } = await connectFake(
      { ...unlockedStatus(), vault: "locked" },
      timers.setTimer,
      (onActivity) => {
        activity = onActivity;
        return () => {
          activity = undefined;
        };
      },
    );
    presenceKernel(kernel);

    // No session yet: the signal is ignored — nothing reaches the kernel.
    activity?.();
    await flush();
    expect(kernel.received).toHaveLength(0);

    await wallet.vault.unlock(unlockPassword);
    activity?.();
    await flush();
    expect(kernel.received.filter((m) => m === "session.touch")).toHaveLength(1);

    // Cooling: further signals inside the interval send nothing.
    activity?.();
    activity?.();
    await flush();
    expect(kernel.received.filter((m) => m === "session.touch")).toHaveLength(1);

    // The interval elapsed: the next signal touches again.
    timers.fireAll();
    activity?.();
    await flush();
    expect(kernel.received.filter((m) => m === "session.touch")).toHaveLength(2);
  });

  it("destroy removes the subscription and the pending cooldown timer", async () => {
    const timers = new FakeTimers();
    let activity: (() => void) | undefined;
    let unsubscribed = false;
    const { wallet, kernel } = await connectFake(
      { ...unlockedStatus(), vault: "locked" },
      timers.setTimer,
      (onActivity) => {
        activity = onActivity;
        return () => {
          unsubscribed = true;
        };
      },
    );
    presenceKernel(kernel);
    await wallet.vault.unlock(unlockPassword);
    activity?.();
    await flush();
    expect(kernel.received).toContain("session.touch");
    expect(timers.armed).toBe(1); // the cooldown window
    await wallet.destroy();
    expect(unsubscribed).toBe(true);
    expect(timers.armed).toBe(0);
    // A stray signal after destroy sends nothing.
    activity?.();
    await flush();
    expect(kernel.received.filter((m) => m === "session.touch")).toHaveLength(1);
  });
});

describe("unwrapGiftWraps chunking", () => {
  const giftWrap = (index: number): Event => ({
    id: index.toString(16).padStart(64, "0"),
    pubkey: PUBLIC_KEY,
    sig: "0".repeat(128),
    kind: 1059,
    created_at: 1,
    tags: [],
    content: "wrapped",
  });

  it("splits oversized batches into MAX_BATCH chunks and concatenates in order", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    const sizes: number[] = [];
    kernel.handlers.set("nostr.unwrapGiftWraps", (request) => {
      const params = request.params as { events: Array<{ id: string }> };
      sizes.push(params.events.length);
      return {
        ok: {
          results: params.events.map((event) => ({
            ok: {
              id: event.id,
              pubkey: PUBLIC_KEY,
              kind: 1,
              created_at: 1,
              tags: [],
              content: "rumor",
            },
          })),
        },
      };
    });
    const signer = nostr(wallet).signer(NOSTR_KEY.ref);
    const results = await signer.unwrapGiftWraps(
      Array.from({ length: 130 }, (_, i) => giftWrap(i)),
    );
    expect(sizes).toStrictEqual([64, 64, 2]);
    // Concatenated in order: result i answers request event i.
    expect(results).toStrictEqual(
      Array.from({ length: 130 }, (_, i) => ({
        id: i.toString(16).padStart(64, "0"),
        pubkey: PUBLIC_KEY,
        kind: 1,
        created_at: 1,
        tags: [],
        content: "rumor",
      })),
    );
  });

  it("an empty input resolves [] without a kernel call", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    const signer = nostr(wallet).signer(NOSTR_KEY.ref);
    await expect(signer.unwrapGiftWraps([])).resolves.toStrictEqual([]);
    expect(kernel.received).not.toContain("nostr.unwrapGiftWraps");
  });
});

describe("nostr api methods", () => {
  const KEY: NostrKeyInfo = {
    ref: { kind: "derived", walletId: "0123456789abcdef", index: 0 },
    publicKey: PUBLIC_KEY,
    createdAt: 1,
  };

  it("discover returns the kernel's keys", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("nostr.discover", () => ({
      ok: { keys: [{ index: 0, publicKey: PUBLIC_KEY }] },
    }));
    const got = await nostr(wallet).discover("0123456789abcdef", 0, 5);
    expect(got).toStrictEqual([{ index: 0, publicKey: PUBLIC_KEY }]);
    expect(kernel.received).toContain("nostr.discover");
  });

  it("deriveKey returns the kernel's key info", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("nostr.deriveKey", () => ({ ok: KEY }));
    await expect(nostr(wallet).deriveKey("0123456789abcdef", 0)).resolves.toStrictEqual(KEY);
  });

  it("exportKey wraps the kernel's bytes in a one-shot secret", async () => {
    const { wallet, kernel } = await connectFake(unlockedStatus());
    kernel.handlers.set("nostr.exportKey", () => ({ ok: new Uint8Array(16).fill(1) }));
    const secret = await nostr(wallet).exportKey(
      NOSTR_KEY.ref,
      { kind: "nsec" },
      {
        kind: "password",
        password: "pw",
      },
    );
    expect(secret).toBeDefined();
    expect(kernel.received).toContain("nostr.exportKey");
  });

  it("rejects a foreign wallet object", () => {
    expect(() => nostr({} as never)).toThrow(WalletError);
  });
});
