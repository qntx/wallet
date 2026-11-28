/**
 * Every secret field in a posted request travels on that post's transfer list, and every wire
 * handed to the channel is wiped when the request never posts — whatever the failure.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, expectTypeOf, it, vi } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";

import { chains } from "../src/chains/index.ts";
import { Channel } from "../src/channel.ts";
import type { MainPort, PortExit, SetTimer } from "../src/channel.ts";
import { SecretWire } from "../src/factors.ts";
import type {
  BytesFieldOf,
  PasskeyCeremony,
  PrfResult,
  PublicBytesField,
  SecretField,
  SecretMethod,
  UnclassifiedBytesField,
} from "../src/factors.ts";
import { internalsOf } from "../src/internal.ts";
import type { WalletInternals } from "../src/internal.ts";
import { nostr } from "../src/nostr/index.ts";
import { SECRET_FIELDS } from "../src/protocol/index.ts";
import type { MethodName, ParamsOf, ProtocolValue } from "../src/protocol/index.ts";
import { spark } from "../src/spark/index.ts";
import { WalletError } from "../src/types.ts";
import type { NostrKeyInfo, StatusPayload, Wallet } from "../src/types.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, PASSKEY, ScriptedPort, unlockedStatus } from "./host.test.ts";

const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password", password: PASSWORD } as const;

const NOSTR_KEY: NostrKeyInfo = {
  ref: { kind: "derived", walletId: "0123456789abcdef", index: 0 },
  publicKey: "0".repeat(64),
  createdAt: 1,
};

function uninitializedStatus(): StatusPayload {
  return {
    ...unlockedStatus(),
    vault: { status: "uninitialized" },
    appLock: false,
    factors: [],
    nostr: { keys: [NOSTR_KEY] },
  };
}

const ceremony: PasskeyCeremony = {
  create: async (): Promise<PrfResult> => {
    await Promise.resolve();
    return {
      credentialId: new Uint8Array(16).fill(1),
      first: new Uint8Array(32).fill(7),
      second: new Uint8Array(32).fill(9),
      synced: true,
    };
  },
  assert: async (): Promise<PrfResult> => {
    await Promise.resolve();
    return {
      credentialId: new Uint8Array(16).fill(1),
      first: new Uint8Array(32).fill(7),
      second: new Uint8Array(32).fill(9),
      userHandle: new Uint8Array([1, 0, 0, 0]),
      synced: true,
    };
  },
};

const realtime: SetTimer = (delayMs, fn) => {
  const timer = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

type PostedRequest = {
  readonly method: string;
  readonly params: unknown;
  readonly transfer: ArrayBuffer[];
};

class RecordingPort extends ScriptedPort {
  readonly records: PostedRequest[] = [];

  override post(message: ProtocolValue, transfer?: ArrayBuffer[]): void {
    const envelope = message as { readonly method?: unknown; readonly params?: unknown };
    this.records.push({
      method: typeof envelope.method === "string" ? envelope.method : "",
      params: envelope.params,
      transfer: transfer ?? [],
    });
    super.post(message, transfer);
  }
}

const connect = async (
  status: StatusPayload,
  portClass: new (kernel: FakeKernel) => RecordingPort = RecordingPort,
  ceremonyImpl?: PasskeyCeremony,
): Promise<{ wallet: Wallet; kernel: FakeKernel; port: RecordingPort }> => {
  const kernel = new FakeKernel(status);
  const port = new portClass(kernel);
  const wallet = await connectKernel({
    verifyEvent,
    spawn: () => {
      kernel.attach(port);
      return port;
    },
    factors: "software",
    passkey: PASSKEY,
    ceremony: ceremonyImpl,
    setTimer: realtime,
  });
  return { wallet, kernel, port };
};

const posted = async (port: RecordingPort, method: string): Promise<PostedRequest> => {
  for (let i = 0; i < 50; i++) {
    const found = port.records.find((r) => r.method === method);
    if (found !== undefined) {
      return found;
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until the channel has posted
    await new Promise((resolve) => setTimeout(resolve));
  }
  throw new Error(`no ${method} request was posted`);
};

/**
 * Waits for `method`'s post, asserts every secret-field buffer is on its transfer list, and returns
 * how many secret byte arrays were found.
 */
const secretsOnTransfer = async (port: RecordingPort, method: string): Promise<number> => {
  const record = await posted(port, method);
  const secrets = secretBytes(record.params);
  for (const bytes of secrets) {
    expect(record.transfer).toContain(bytes.buffer);
  }
  return secrets.length;
};

/** Asserts every method posted and that each carried at least `min` secret byte arrays. */
const expectSecretsPosted = async (
  port: RecordingPort,
  methods: string[],
  min = 1,
): Promise<void> => {
  const counts = await Promise.all(methods.map(async (method) => secretsOnTransfer(port, method)));
  for (const count of counts) {
    expect(count).toBeGreaterThanOrEqual(min);
  }
};

const SECRET_SET = new Set<string>(SECRET_FIELDS);

/** Every Uint8Array under `value`, however nested. */
function collectBytes(value: unknown, out: Uint8Array[]): void {
  if (value instanceof Uint8Array) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectBytes(entry, out);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      collectBytes(entry, out);
    }
  }
}

/** Every Uint8Array stored under a secret field name anywhere in the params. */
function secretBytes(params: unknown): Uint8Array[] {
  const out: Uint8Array[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object" || value instanceof Uint8Array) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_SET.has(key)) {
        collectBytes(entry, out);
      } else {
        walk(entry);
      }
    }
  };
  walk(params);
  return out;
}

const zeroed = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

describe("every secret field travels on the transfer list", () => {
  it("vault.unlock / addFactor / removeFactor / setAppLock / setBlindSigning", async () => {
    const { wallet, port } = await connect(uninitializedStatus());
    const calls = [
      wallet.vault.unlock(VERIFY).catch(() => undefined),
      wallet.vault
        .addFactor({ kind: "password", password: "a second password" }, VERIFY)
        .catch(() => undefined),
      wallet.vault.removeFactor("f".repeat(32), VERIFY).catch(() => undefined),
      wallet.vault.setAppLock(true, VERIFY).catch(() => undefined),
      wallet.vault.setBlindSigning(true, VERIFY).catch(() => undefined),
    ];
    await expectSecretsPosted(port, [
      "vault.unlock",
      "vault.addFactor",
      "vault.removeFactor",
      "vault.setAppLock",
      "vault.setBlindSigning",
    ]);
    expect(port.records.length).toBeGreaterThan(0);
    await wallet.destroy();
    await Promise.all(calls);
  });

  it("keys.import / keys.remove / keys.export", async () => {
    const { wallet, port } = await connect(uninitializedStatus());
    const calls = [
      wallet.keys.import("evm", `0x${"ab".repeat(32)}`).catch(() => undefined),
      wallet.keys.remove("k".repeat(32), VERIFY).catch(() => undefined),
      wallet.keys.export("k".repeat(32), VERIFY).catch(() => undefined),
    ];
    await expectSecretsPosted(port, ["keys.import", "keys.remove", "keys.export"]);
    expect(port.records.length).toBeGreaterThan(0);
    await wallet.destroy();
    await Promise.all(calls);
  });

  it("keys.import posts a bare-hex TRON secret and rejects malformed ones", async () => {
    const { wallet, port } = await connect(uninitializedStatus());
    const call = wallet.keys.import("tron", "ab".repeat(32)).catch(() => undefined);
    await expectSecretsPosted(port, ["keys.import"]);
    await call;
    await Promise.all(
      [`0x${"ab".repeat(32)}`, "zz".repeat(32), "ab".repeat(31)].map(async (secret) =>
        expect(wallet.keys.import("tron", secret)).rejects.toThrow(
          expect.objectContaining({ code: "invalid-input" }),
        ),
      ),
    );
    expect(port.records).toHaveLength(1);
    await wallet.destroy();
  });

  it("wallet.createWithPasskey / restoreWithPasskey carry the PRF output", async () => {
    const { wallet, port } = await connect(uninitializedStatus(), RecordingPort, ceremony);
    const calls = [
      wallet.wallets
        .createWithPasskey({ name: "alice", factor: { kind: "password", password: "pw" } })
        .catch(() => undefined),
      wallet.wallets
        .restoreWithPasskey({ factor: { kind: "password", password: "pw" } })
        .catch(() => undefined),
    ];
    // prfWallet (wallet entropy material) plus the initial-factor password.
    await expectSecretsPosted(port, ["wallet.createWithPasskey", "wallet.restoreWithPasskey"], 2);
    expect(port.records.length).toBeGreaterThan(0);
    await wallet.destroy();
    await Promise.all(calls);
  });

  it("wallet.createMnemonic + confirm / importMnemonic / exportMnemonic / delete", async () => {
    const { wallet, kernel, port } = await connect(uninitializedStatus());
    kernel.handlers.set("wallet.createMnemonic", () => ({
      ok: {
        draft: "d".repeat(32),
        words: new Uint8Array(24).fill(1),
        quiz: [0, 1, 2],
      },
    }));
    const draft = await wallet.wallets.createMnemonic({
      words: 12,
      factor: { kind: "password", password: "pw" },
    });
    const calls = [
      draft.confirm(["alpha", "beta", "gamma"], { passphrase: "pp" }).catch(() => undefined),
      wallet.wallets
        .importMnemonic({
          mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
          passphrase: "pp",
          factor: { kind: "password", password: "pw" },
        })
        .catch(() => undefined),
      wallet.wallets.exportMnemonic("0123456789abcdef", VERIFY).catch(() => undefined),
      wallet.wallets.delete("0123456789abcdef", VERIFY).catch(() => undefined),
    ];
    await expectSecretsPosted(port, [
      "wallet.createMnemonic",
      "wallet.confirmMnemonic",
      "wallet.importMnemonic",
      "wallet.exportMnemonic",
      "wallet.delete",
    ]);
    expect(port.records.length).toBeGreaterThan(0);
    await wallet.destroy();
    await Promise.all(calls);
  });

  it("backup.enable / disable / restore", async () => {
    const { wallet, port } = await connect(uninitializedStatus());
    const calls = [
      wallet.backup
        .enable({ verify: VERIFY, factors: [{ kind: "password", password: "backup pw" }] })
        .catch(() => undefined),
      wallet.backup.disable(VERIFY).catch(() => undefined),
      wallet.backup
        .restore({
          envelope: "qbackup1envelope",
          backupFactor: { kind: "password", password: "backup pw" },
          passphrases: [{ walletId: "w", passphrase: "pp" }],
          factor: { kind: "password", password: "pw" },
        })
        .catch(() => undefined),
    ];
    await expectSecretsPosted(port, ["backup.enable", "backup.disable", "backup.restore"]);
    expect(port.records.length).toBeGreaterThan(0);
    await wallet.destroy();
    await Promise.all(calls);
  });

  it("nostr.exportKey carries the verify factor and the ncryptsec password", async () => {
    const { wallet, port } = await connect(uninitializedStatus());
    const call = nostr(wallet)
      .exportKey(NOSTR_KEY.ref, { kind: "ncryptsec", password: "ncryptsec pw" }, VERIFY)
      .catch(() => undefined);
    const record = await posted(port, "nostr.exportKey");
    const secrets = secretBytes(record.params);
    expect(secrets).toHaveLength(2);
    for (const bytes of secrets) {
      expect(record.transfer).toContain(bytes.buffer);
    }
    await wallet.destroy();
    await call;
  });

  it("chain.sign and spark.approve carry the verify factor", async () => {
    const { wallet, port } = await connect(uninitializedStatus());
    const calls = [
      chains(wallet)
        .sign({
          request: {
            kind: "evm.personal-message",
            network: "eip155:1",
            account: {
              kind: "hd",
              walletId: "0a".repeat(8),
              groupIndex: 0,
              template: "evm.bip44",
            },
            message: utf8ToBytes("hello"),
          },
          verify: VERIFY,
        })
        .catch(() => undefined),
      spark(wallet)
        .approve({
          account: { walletId: "0a".repeat(8), groupIndex: 0, network: "regtest" },
          intent: {
            kind: "transfer",
            receivers: [{ identityPublicKey: new Uint8Array(33).fill(2), amountSats: 1000 }],
          },
          verify: VERIFY,
        })
        .catch(() => undefined),
    ];
    await expectSecretsPosted(port, ["chain.sign", "spark.approve"]);
    expect(port.records.length).toBeGreaterThan(0);
    await wallet.destroy();
    await Promise.all(calls);
  });
});

describe("a request that never posts wipes its wire", () => {
  class ThrowingPort extends RecordingPort {
    override post(message: ProtocolValue, transfer?: ArrayBuffer[]): void {
      this.records.push({
        method: String((message as { method?: unknown }).method ?? ""),
        params: (message as { params?: unknown }).params,
        transfer: transfer ?? [],
      });
      throw new Error("the port refused the frame");
    }
  }

  it("post throwing rejects the call and zeroes every secret buffer", async () => {
    const { wallet, port } = await connect(uninitializedStatus(), ThrowingPort);
    await expect(wallet.vault.unlock(VERIFY)).rejects.toThrow(
      expect.objectContaining({ code: "integrity" }),
    );
    const record = port.records.find((r) => r.method === "vault.unlock");
    expect(record).toBeDefined();
    for (const bytes of secretBytes(record?.params)) {
      expect(zeroed(bytes)).toBe(true);
    }
    await wallet.destroy();
  });

  it("a destroyed wallet wipes the wire a build already filled", async () => {
    const { wallet } = await connect(uninitializedStatus());
    const internals = internalsOf(wallet);
    await wallet.destroy();
    const seen: Uint8Array[] = [];
    await expect(
      internals.secretCall("vault.unlock", (wire) => {
        const password = wire.text("top secret");
        seen.push(password);
        return { factor: { kind: "password", password } };
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "locked" }));
    expect(seen).toHaveLength(1);
    for (const bytes of seen) {
      expect(zeroed(bytes)).toBe(true);
    }
  });

  it("an oversized request wipes the wire", async () => {
    const { wallet } = await connect(uninitializedStatus());
    const internals = internalsOf(wallet);
    const seen: Uint8Array[] = [];
    await expect(
      internals.secretCall("wallet.delete", async (wire) => {
        const verify = await internals.resolveVerifyFactor(VERIFY, wire);
        collectBytes(verify, seen);
        return { verify, walletId: "x".repeat(1_048_576) };
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(seen).toHaveLength(1);
    for (const bytes of seen) {
      expect(zeroed(bytes)).toBe(true);
    }
    await wallet.destroy();
  });

  it("a build failure after a secret was wired wipes the wire", async () => {
    const { wallet } = await connect(uninitializedStatus());
    const internals = internalsOf(wallet);
    const seen: Uint8Array[] = [];
    await expect(
      internals.secretCall("backup.enable", async (wire) => {
        const verify = await internals.resolveVerifyFactor(VERIFY, wire);
        collectBytes(verify, seen);
        throw new WalletError("cancelled", "the backup ceremony was cancelled");
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "cancelled" }));
    expect(seen).toHaveLength(1);
    for (const bytes of seen) {
      expect(zeroed(bytes)).toBe(true);
    }
    await wallet.destroy();
  });

  it("a ready-gate rejection wipes the wire", async () => {
    // A port that dies before its first status breaks the channel: calls awaiting readiness
    // reject rather than hang, and their wires are wiped.
    class DeadPort implements MainPort {
      post(): void {}
      listen(): () => void {
        return () => {};
      }
      onExit(handler: (reason: PortExit) => void): () => void {
        handler("crashed");
        return () => {};
      }
      terminate(): void {}
    }
    const channel = new Channel(
      () => new DeadPort(),
      { onStatus: () => {}, onLocked: () => {}, onCrashed: () => {} },
      realtime,
    );
    await expect(channel.start()).rejects.toThrow(expect.objectContaining({ code: "integrity" }));
    const wire = new SecretWire();
    const secret = wire.text("top secret");
    await expect(
      channel.callWithSecrets(
        "vault.unlock",
        {
          factor: { kind: "password", password: secret },
        },
        wire,
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "integrity" }));
    expect(zeroed(secret)).toBe(true);
  });
});

describe("passkey ceremony ordering and output wiping", () => {
  it("an initialized vault with a factor rejects before any ceremony", async () => {
    const createCalls: unknown[] = [];
    const assertCalls: unknown[] = [];
    const counting: PasskeyCeremony = {
      create: async (input) => {
        createCalls.push(input);
        const result = await ceremony.create(input);
        return result;
      },
      assert: async (input) => {
        assertCalls.push(input);
        const result = await ceremony.assert(input);
        return result;
      },
    };
    const { wallet } = await connect(
      { ...uninitializedStatus(), vault: { status: "locked" } },
      RecordingPort,
      counting,
    );
    const factor = { kind: "password", password: "pw" } as const;
    await expect(wallet.wallets.createWithPasskey({ name: "alice", factor })).rejects.toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
    await expect(wallet.wallets.restoreWithPasskey({ factor })).rejects.toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
    expect(createCalls).toHaveLength(0);
    expect(assertCalls).toHaveLength(0);
    await wallet.destroy();
  });

  it("a missing vault PRF output rejects with the wallet PRF output zeroed", async () => {
    const first = new Uint8Array(32).fill(7);
    const noSecond: PasskeyCeremony = {
      create: async () => {
        await Promise.resolve();
        return {
          credentialId: new Uint8Array(16).fill(1),
          first,
          synced: true,
        };
      },
      assert: ceremony.assert,
    };
    const { wallet } = await connect(uninitializedStatus(), RecordingPort, noSecond);
    await expect(wallet.wallets.createWithPasskey({ name: "alice" })).rejects.toThrow(
      expect.objectContaining({ code: "passkey-prf-unsupported" }),
    );
    expect(zeroed(first)).toBe(true);
    await wallet.destroy();
  });

  it("a vault initialized during create's ceremony rejects, outputs zeroed", async () => {
    const first = new Uint8Array(32).fill(7);
    const second = new Uint8Array(32).fill(9);
    let gate: (() => void) | undefined;
    const blocked: PasskeyCeremony = {
      create: async () => {
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
        return {
          credentialId: new Uint8Array(16).fill(1),
          first,
          second,
          synced: true,
        };
      },
      assert: ceremony.assert,
    };
    const { wallet, kernel } = await connect(uninitializedStatus(), RecordingPort, blocked);
    const call = wallet.wallets.createWithPasskey({
      name: "alice",
      factor: { kind: "password", password: "pw" },
    });
    await new Promise((resolve) => setTimeout(resolve));
    // The vault initialized while the ceremony was pending: the given factor no longer applies.
    kernel.status = { ...kernel.status, vault: { status: "locked" } };
    kernel.pushStatus();
    gate?.();
    await expect(call).rejects.toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(zeroed(first)).toBe(true);
    expect(zeroed(second)).toBe(true);
    await wallet.destroy();
  });

  it("a vault initialized during restore's ceremony rejects, outputs zeroed", async () => {
    const first = new Uint8Array(32).fill(7);
    const second = new Uint8Array(32).fill(9);
    let gate: (() => void) | undefined;
    const blocked: PasskeyCeremony = {
      create: ceremony.create,
      assert: async () => {
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
        return {
          credentialId: new Uint8Array(16).fill(1),
          first,
          second,
          userHandle: new Uint8Array([1, 0, 0, 0]),
          synced: true,
        };
      },
    };
    const { wallet, kernel } = await connect(uninitializedStatus(), RecordingPort, blocked);
    const call = wallet.wallets.restoreWithPasskey({
      factor: { kind: "password", password: "pw" },
    });
    await new Promise((resolve) => setTimeout(resolve));
    kernel.status = { ...kernel.status, vault: { status: "locked" } };
    kernel.pushStatus();
    gate?.();
    await expect(call).rejects.toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(zeroed(first)).toBe(true);
    expect(zeroed(second)).toBe(true);
    await wallet.destroy();
  });

  it("a wrong-purpose passkey rejects with both ceremony outputs zeroed", async () => {
    const first = new Uint8Array(32).fill(7);
    const second = new Uint8Array(32).fill(9);
    const wrongPurpose: PasskeyCeremony = {
      create: ceremony.create,
      assert: async () => {
        await Promise.resolve();
        return {
          credentialId: new Uint8Array(16).fill(1),
          first,
          second,
          userHandle: new Uint8Array([0, 0, 0, 0]),
          synced: true,
        };
      },
    };
    const { wallet } = await connect(uninitializedStatus(), RecordingPort, wrongPurpose);
    await expect(wallet.wallets.restoreWithPasskey()).rejects.toThrow(
      expect.objectContaining({ code: "wrong-passkey" }),
    );
    expect(zeroed(first)).toBe(true);
    expect(zeroed(second)).toBe(true);
    await wallet.destroy();
  });
});

describe("a wire that outlives its request", () => {
  it("bytes(…, true) zeroes the secret original it copied", () => {
    const wire = new SecretWire();
    const source = new Uint8Array(32).fill(0xab);
    const copy = wire.bytes(source, true);
    expect(zeroed(source)).toBe(true);
    expect(copy).toStrictEqual(new Uint8Array(32).fill(0xab));
    expect(wire.transfer).toStrictEqual([copy.buffer]);
  });

  it("zeroes a copy made after wipe() at once and never records it", () => {
    const wire = new SecretWire();
    wire.bytes(new Uint8Array([1]));
    wire.wipe();
    const source = new Uint8Array(32).fill(0xab);
    const late = wire.bytes(source, true);
    expect(zeroed(source)).toBe(true);
    expect(zeroed(late)).toBe(true);
    expect(wire.transfer).toHaveLength(1);
  });
});

describe("backup factor ceremonies", () => {
  const twoPasskeys = (): StatusPayload => ({
    ...unlockedStatus(),
    vault: { status: "locked" },
    factors: [
      { kind: "passkey", id: "f".repeat(32), credentialId: "Y3JlZA", createdAt: 1 },
      { kind: "passkey", id: "e".repeat(32), credentialId: "Y3JlZA", createdAt: 2 },
    ],
  });

  /** A ceremony whose asserts take turns from `answers`, recording how many ran at once. */
  const scripted = (
    answers: ReadonlyArray<() => Promise<PrfResult>>,
  ): PasskeyCeremony & { readonly calls: () => number; readonly overlap: () => number } => {
    let calls = 0;
    let running = 0;
    let overlap = 0;
    return {
      calls: () => calls,
      overlap: () => overlap,
      create: async () => Promise.reject(new Error("no create in this test")),
      assert: async () => {
        const answer = answers[calls];
        calls += 1;
        running += 1;
        overlap = Math.max(overlap, running);
        try {
          return await (answer ?? (async () => Promise.reject(new Error("unscripted"))))();
        } finally {
          running -= 1;
        }
      },
    };
  };

  const later = async <T>(value: T): Promise<T> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(value);
      }, 5);
    });

  const prf = (fill: number): PrfResult => ({
    credentialId: new Uint8Array([1]),
    first: new Uint8Array(32).fill(fill),
    synced: false,
  });

  it("a failed factor stops the enable before the next ceremony starts", async () => {
    const ceremonyImpl = scripted([
      async () => Promise.reject(new WalletError("cancelled", "the backup ceremony was cancelled")),
      async () => later(prf(0xab)),
    ]);
    const { wallet, port } = await connect(twoPasskeys(), RecordingPort, ceremonyImpl);
    await wallet.vault.unlock({ kind: "password", password: PASSWORD });
    const assertsBefore = ceremonyImpl.calls();
    const spy = vi.spyOn(SecretWire.prototype, "bytes");
    try {
      await expect(
        wallet.backup.enable({
          verify: VERIFY,
          factors: [{ kind: "passkey" }, { kind: "passkey" }],
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "cancelled" }));
      await later(undefined);
      await later(undefined);
      expect(ceremonyImpl.calls() - assertsBefore).toBe(1);
      const resident = spy.mock.results
        .map((result) => result.value as Uint8Array)
        .filter((copy) => !zeroed(copy));
      expect(resident).toStrictEqual([]);
      expect(port.records.some((record) => record.method === "backup.enable")).toBe(false);
    } finally {
      spy.mockRestore();
      await wallet.destroy();
    }
  });

  it("runs the factor ceremonies one at a time and wires every output", async () => {
    const ceremonyImpl = scripted([async () => later(prf(0x11)), async () => later(prf(0x22))]);
    const { wallet, port } = await connect(twoPasskeys(), RecordingPort, ceremonyImpl);
    await wallet.vault.unlock({ kind: "password", password: PASSWORD });
    const call = wallet.backup
      .enable({ verify: VERIFY, factors: [{ kind: "passkey" }, { kind: "passkey" }] })
      .catch(() => undefined);
    // The verify password and both factors' PRF outputs, every one on the transfer list.
    await expect(secretsOnTransfer(port, "backup.enable")).resolves.toBe(3);
    expect(ceremonyImpl.calls()).toBeGreaterThanOrEqual(2);
    expect(ceremonyImpl.overlap()).toBe(1);
    await wallet.destroy();
    await call;
  });
});

describe("method classification", () => {
  it("compiles only the secret-bearing methods as SecretMethod", () => {
    expectTypeOf<SecretMethod>().toEqualTypeOf<
      | "vault.unlock"
      | "vault.addFactor"
      | "vault.removeFactor"
      | "vault.setAppLock"
      | "vault.setBlindSigning"
      | "wallet.createWithPasskey"
      | "wallet.restoreWithPasskey"
      | "wallet.createMnemonic"
      | "wallet.confirmMnemonic"
      | "wallet.importMnemonic"
      | "wallet.exportMnemonic"
      | "wallet.delete"
      | "keys.import"
      | "keys.remove"
      | "keys.export"
      | "backup.enable"
      | "backup.disable"
      | "backup.restore"
      | "card.begin"
      | "nostr.exportKey"
      | "chain.sign"
      | "chain.exportAccount"
      | "spark.approve"
      | "sessions.create"
      | "sessions.open"
      | "hardware.begin"
    >();

    // Type-level assertions live in a never-invoked function: tsc checks the body.
    expect(typeOnlyChecks).toBeTypeOf("function");
  });

  it("classifies every params byte field as secret or public", () => {
    expectTypeOf<UnclassifiedBytesField>().toBeNever();
    expect(bytesFieldChecks).toBeTypeOf("function");
  });

  it("pins the secret and public byte-field lists exactly", () => {
    expectTypeOf<SecretField>().toEqualTypeOf<
      | "password"
      | "prf"
      | "prfWallet"
      | "prfBackup"
      | "mnemonic"
      | "passphrase"
      | "secret"
      | "answers"
    >();
    expectTypeOf<PublicBytesField>().toEqualTypeOf<
      | "adaptorPublicKey"
      | "binding"
      | "challenge"
      | "ciphertext"
      | "ciphertexts"
      | "cbor"
      | "connectorTx"
      | "credentialId"
      | "data"
      | "exitTx"
      | "hashLockPublicKey"
      | "hiding"
      | "identityPublicKey"
      | "info"
      | "invoice"
      | "limits"
      | "message"
      | "ownerPublicKey"
      | "package"
      | "params"
      | "partialTransaction"
      | "paymentHash"
      | "psbt"
      | "rawData"
      | "publicKey"
      | "receiverIdentityPublicKey"
      | "script"
      | "secretCipher"
      | "signatureShare"
      | "sspSignature"
      | "tokenIdentifier"
      | "tokens"
      | "transaction"
      | "txid"
      | "verifyingKey"
    >();
  });

  it("sends every method whose params carry an answers field through the secret call", () => {
    expectTypeOf<ParamsCarrying<"answers">>().toEqualTypeOf<"wallet.confirmMnemonic">();
    expectTypeOf<Extract<ParamsCarrying<"answers">, SecretMethod>>().toEqualTypeOf<
      ParamsCarrying<"answers">
    >();
  });
});

/* True when any field reachable through T's objects, arrays or union members is named F. The
   `ProtocolValue extends T` stop keeps the walk out of the recursive wire type — a pass-through
   `params` field is its method's own validation domain. */
type CarriesField<T, F extends PropertyKey> = ProtocolValue extends T
  ? false
  : T extends ReadonlyArray<infer E>
    ? CarriesField<E, F>
    : T extends Readonly<Record<PropertyKey, unknown>>
      ? true extends {
          [K in keyof T]: K extends F ? true : CarriesField<T[K], F>;
        }[keyof T]
        ? true
        : false
      : false;

/** The methods whose params can carry a field named F. */
type ParamsCarrying<F extends PropertyKey> = {
  [M in MethodName]: true extends CarriesField<ParamsOf<M>, F> ? M : never;
}[MethodName];

// BytesFieldOf boundary cases: nested in an array, inside a union member, and optional.
const bytesFieldChecks = (): void => {
  expectTypeOf<BytesFieldOf<{ a?: ReadonlyArray<{ seed: Uint8Array }> }>>().toEqualTypeOf<"seed">();
  expectTypeOf<BytesFieldOf<{ x: string } | { key?: Uint8Array }>>().toEqualTypeOf<"key">();
  expectTypeOf<BytesFieldOf<Uint8Array>>().toBeNever();
  expectTypeOf<BytesFieldOf<{ answers: ReadonlyArray<Uint8Array> }>>().toEqualTypeOf<"answers">();
  expectTypeOf<BytesFieldOf<{ k?: ReadonlyArray<Uint8Array> }>>().toEqualTypeOf<"k">();
  // Bytes a value can hold under any spelling still name their field: a bytes union member, a
  // nullable array element, a bare buffer, a map value, a set element.
  expectTypeOf<
    BytesFieldOf<{
      a: Uint8Array | string;
      b: ReadonlyArray<Uint8Array | null>;
      c: ArrayBuffer;
      d: Uint8Array;
      e: ReadonlyMap<string, Uint8Array>;
    }>
  >().toEqualTypeOf<"a" | "b" | "c" | "d" | "e">();
  expectTypeOf<BytesFieldOf<{ s: ReadonlySet<Uint8Array> }>>().toEqualTypeOf<"s">();
  expectTypeOf<BytesFieldOf<{ b: SharedArrayBuffer }>>().toEqualTypeOf<"b">();
  expectTypeOf<
    BytesFieldOf<{ m: ReadonlyMap<string, ReadonlyArray<Uint8Array | null>> }>
  >().toEqualTypeOf<"m">();
  // An object inside a container reports its own byte-carrying member, not the field's name.
  expectTypeOf<
    BytesFieldOf<{ m: ReadonlyMap<string, { sig: Uint8Array }> }>
  >().toEqualTypeOf<"sig">();
  expectTypeOf<BytesFieldOf<{ s: ReadonlySet<{ key: Uint8Array }> }>>().toEqualTypeOf<"key">();
  expectTypeOf<BytesFieldOf<{ none: ReadonlyMap<string, string> }>>().toBeNever();
};

const typeOnlyChecks = (channel: Channel, internals: WalletInternals): void => {
  // @ts-expect-error -- secret params may not use the plain call
  void channel.call("vault.unlock", {
    factor: { kind: "password", password: new Uint8Array() },
  });
  // @ts-expect-error -- secret params may not use the plain call
  void internals.call("chain.sign", { request: {}, verify: {} });
  // @ts-expect-error -- plain params may not use callWithSecrets
  void channel.callWithSecrets("keys.list", null, new SecretWire());
};
