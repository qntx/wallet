/**
 * HN-05 — verify-factor secrets are cloned onto the wire instead of transferred, and failed
 * passkey ceremonies leave the PRF output live on the main thread (Web/Node "software" mode).
 *
 * What it demonstrates:
 *  1. chains/index.ts:163-165 and spark/index.ts:20-22 build a `transfer` list for the verify
 *     factor's bytes and then call internals.call WITHOUT it — the password's ArrayBuffer is
 *     structured-cloned (request post carries an empty transfer), so a copy stays resident in
 *     main-thread memory and the original buffer is never detached/zeroed.
 *  2. Contrast: wallet.ts exportMnemonic DOES pass its transfer list — the password's exact
 *     ArrayBuffer travels on it.
 *  3. wallet.ts createWithPasskey / restoreWithPasskey (software branch) run the WebAuthn
 *     ceremony FIRST, then throw "already initialized" without wiping result.first /
 *     result.second — the PRF output (wallet entropy material) stays in main memory.
 *
 * passes = vulnerable (every assertion encodes the current, unsafe behaviour).
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { signEvmPersonalMessage } from "@qntx/wallet-chains/evm/sign";

import { chains } from "../../src/chains/index.ts";
import type { MainPort, PortExit, SetTimer } from "../../src/channel.ts";
import type { PasskeyCeremony, PrfResult } from "../../src/factors.ts";
import type { ProtocolValue } from "../../src/protocol/index.ts";
import { spark } from "../../src/spark/index.ts";
import type {
  LockReason,
  NostrKeyInfo,
  PasskeyConfig,
  StatusPayload,
  WalletErrorCode,
} from "../../src/types.ts";
import { connectKernel } from "../../src/wallet.ts";

// ── Harness copies (from tests/host.test.ts — copied so this file is self-contained) ──────────

const PASSKEY: PasskeyConfig = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};

const NOSTR_KEY: NostrKeyInfo = {
  ref: { kind: "derived", walletId: "0123456789abcdef", index: 0 },
  publicKey: "0".repeat(64),
  createdAt: 1,
};

function unlockedStatus(): StatusPayload {
  return {
    protocol: 3,
    appLock: true,
    verification: "available",
    vault: "unlocked",
    factors: [{ kind: "passkey", id: "f".repeat(32), credentialId: "Y3JlZA", createdAt: 1 }],
    wallets: [],
    nostr: { keys: [NOSTR_KEY] },
    importedKeys: [],
    backup: null,
    blindSigning: false,
  };
}

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

/** A scripted kernel stand-in: delivers status on attach, routes requests through `handlers`. */
class FakeKernel {
  status: StatusPayload;
  readonly handlers: Map<string, Handler> = new Map<string, Handler>();
  readonly received: string[] = [];
  private active: ScriptedPort | undefined;

  constructor(status: StatusPayload) {
    this.status = status;
    this.handlers.set("status", () => ({ ok: this.status }));
    this.handlers.set("vault.unlock", () => {
      this.status = { ...this.status, vault: "unlocked" };
      this.pushStatus();
      return { ok: { session: "0a".repeat(16) } };
    });
  }

  attach(port: ScriptedPort): void {
    this.active = port;
    setTimeout(() => {
      port.send({ v: 3, event: "status", status: this.status });
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
      port.send({ v: 3, id: request.id, ...reply });
    };
    if (handler === undefined) {
      respond({ err: { code: "integrity" } });
      return;
    }
    void Promise.resolve(handler(request)).then(respond);
  }

  lock(reason: LockReason): void {
    this.status = { ...this.status, vault: "locked" };
    this.active?.send({ v: 3, event: "locked", reason });
    this.active?.send({ v: 3, event: "status", status: this.status });
  }

  pushStatus(): void {
    this.active?.send({ v: 3, event: "status", status: this.status });
  }

  send(message: unknown): void {
    this.active?.send(message);
  }
}

class ScriptedPort implements MainPort {
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
}

// ── PoC ──────────────────────────────────────────────────────────────────────────────────────

/** A ScriptedPort that also records the transfer list each request arrived with. */
class RecordingPort extends ScriptedPort {
  readonly records: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly transfer: ArrayBuffer[] | undefined;
  }> = [];

  override post(message: ProtocolValue, transfer?: ArrayBuffer[]): void {
    const envelope = message as { readonly method?: unknown; readonly params?: unknown };
    this.records.push({
      method: typeof envelope.method === "string" ? envelope.method : "",
      params: envelope.params,
      transfer,
    });
    super.post(message);
  }
}

const realtime: SetTimer = (delayMs, fn) => {
  const id = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(id);
  };
};

const connect = async (ceremony?: PasskeyCeremony) => {
  const kernel = new FakeKernel({ ...unlockedStatus(), vault: "locked" });
  const spawned: RecordingPort[] = [];
  const wallet = await connectKernel({
    verifyEvent,
    spawn: () => {
      const port = new RecordingPort(kernel);
      spawned.push(port);
      kernel.attach(port);
      return port;
    },
    factors: "software",
    passkey: PASSKEY,
    ceremony,
    setTimer: realtime,
  });
  // FakeKernel's default vault.unlock handler returns a session; the unlocked status then lands.
  await wallet.vault.unlock({ kind: "password", password: "long enough password" });
  expect(wallet.getSnapshot().vault).toBe("unlocked");
  return { wallet, kernel, spawned };
};

const posted = (
  spawned: RecordingPort[],
  method: string,
): { readonly params: unknown; readonly transfer: ArrayBuffer[] | undefined } => {
  const record = spawned[0]?.records.find((r) => r.method === method);
  expect(record).toBeDefined();
  return record!;
};

const verifyPasswordOf = (params: unknown): Uint8Array => {
  const password = (params as { verify: { password: Uint8Array } }).verify.password;
  expect(password).toBeInstanceOf(Uint8Array);
  return password;
};

describe("HN-05: verify-factor secrets are cloned, not transferred", () => {
  const PRIV = new Uint8Array(32).fill(7);
  const ADDRESS = "0x4a62316623ad457F02cDC5D997deD67a383EC569";
  const MESSAGE = utf8ToBytes("hello");
  const PASSWORD = "correct horse battery staple";

  it("chain.sign drops the transfer list carrying the verify password", async () => {
    const { wallet, kernel, spawned } = await connect();
    kernel.handlers.set("chain.sign", () => ({
      ok: { kind: "evm.personal-message", signature: signEvmPersonalMessage(MESSAGE, PRIV) },
    }));
    kernel.handlers.set("wallet.accounts", () => ({
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS },
    }));
    const result = await chains(wallet).sign({
      request: {
        kind: "evm.personal-message",
        network: "eip155:1",
        account: {
          kind: "hd",
          walletId: "0a".repeat(8),
          groupIndex: 0,
          template: "evm.bip44",
        },
        message: MESSAGE,
      },
      verify: { kind: "password", password: PASSWORD },
    });
    expect(result.kind).toBe("evm.personal-message");

    const { params, transfer } = posted(spawned, "chain.sign");
    // The wire factor carries the password bytes…
    const password = verifyPasswordOf(params);
    expect(password.byteLength).toBe(PASSWORD.length);
    // …but the post went out with NO transfer list: the buffer was structured-cloned, so the
    // secret copy stays in main-thread memory — the original is never detached or zeroed.
    expect(transfer ?? []).toHaveLength(0);
    expect(password.buffer.byteLength).toBeGreaterThan(0);
    await wallet.destroy();
  });

  it("contrast: exportMnemonic puts the password's exact ArrayBuffer on the transfer list", async () => {
    const { wallet, kernel, spawned } = await connect();
    kernel.handlers.set("wallet.exportMnemonic", () => ({
      ok: { mnemonic: new Uint8Array(24).fill(1) },
    }));
    await wallet.wallets.exportMnemonic("0123456789abcdef", {
      kind: "password",
      password: PASSWORD,
    });
    const { params, transfer } = posted(spawned, "wallet.exportMnemonic");
    const password = verifyPasswordOf(params);
    // The sane path for comparison: the very buffer holding the secret is transferred.
    expect(transfer).toContain(password.buffer);
    await wallet.destroy();
  });

  it("spark.approve drops the transfer list carrying the verify password too", async () => {
    const { wallet, kernel, spawned } = await connect();
    const identityPublicKey = new Uint8Array(33).fill(2);
    kernel.handlers.set("spark.approve", () => ({
      ok: { kind: "transfer", receivers: [{ identityPublicKey, amountSats: 1000 }] },
    }));
    await spark(wallet).approve({
      account: { walletId: "0123456789abcdef", groupIndex: 0, network: "regtest" },
      intent: {
        kind: "transfer",
        receivers: [{ identityPublicKey, amountSats: 1000 }],
      },
      verify: { kind: "password", password: PASSWORD },
    });
    const { params, transfer } = posted(spawned, "spark.approve");
    const password = verifyPasswordOf(params);
    expect(password.byteLength).toBe(PASSWORD.length);
    expect(transfer ?? []).toHaveLength(0);
    expect(password.buffer.byteLength).toBeGreaterThan(0);
    await wallet.destroy();
  });
});

describe("HN-05: failed passkey ceremonies leave the PRF output in main memory", () => {
  const credentialId = new Uint8Array(16).fill(1);

  it("createWithPasskey registers a credential, then throws already-initialized without wiping", async () => {
    const first = new Uint8Array(32).fill(7);
    const second = new Uint8Array(32).fill(9);
    const createCalls: unknown[] = [];
    const ceremony: PasskeyCeremony = {
      create: async (input) => {
        createCalls.push(input);
        return { credentialId, first, second, synced: true };
      },
      assert: async (): Promise<PrfResult> => {
        throw new Error("assert should not run");
      },
    };
    const { wallet } = await connect(ceremony);
    // Vault already initialized + a factor provided → invalid-input, but only AFTER the WebAuthn
    // ceremony produced PRF output on the main thread.
    await expect(
      wallet.wallets.createWithPasskey({
        name: "alice",
        factor: { kind: "password", password: "correct horse battery staple" },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-input" }) as unknown as Error);
    expect(createCalls).toHaveLength(1);
    // The wallet-entropy PRF output (first) and the unused vault PRF output (second) are both
    // still live — nothing wiped them before throwing.
    expect(first).toStrictEqual(new Uint8Array(32).fill(7));
    expect(second).toStrictEqual(new Uint8Array(32).fill(9));
    await wallet.destroy();
  });

  it("restoreWithPasskey asserts a credential, then throws already-initialized without wiping", async () => {
    const first = new Uint8Array(32).fill(7);
    const second = new Uint8Array(32).fill(9);
    const assertCalls: unknown[] = [];
    const ceremony: PasskeyCeremony = {
      create: async (): Promise<PrfResult> => {
        throw new Error("create should not run");
      },
      assert: async (input) => {
        assertCalls.push(input);
        // userHandle[0] = 0x01 (PASSKEY_PURPOSE_WALLET) so the purpose check passes and the
        // initialized+factor branch is what throws.
        return { credentialId, first, second, userHandle: new Uint8Array([1, 0, 0, 0]) , synced: true };
      },
    };
    const { wallet } = await connect(ceremony);
    await expect(
      wallet.wallets.restoreWithPasskey({
        factor: { kind: "password", password: "correct horse battery staple" },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-input" }) as unknown as Error);
    expect(assertCalls).toHaveLength(1);
    expect(first).toStrictEqual(new Uint8Array(32).fill(7));
    expect(second).toStrictEqual(new Uint8Array(32).fill(9));
    await wallet.destroy();
  });
});
