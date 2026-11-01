/**
 * Kernel-run passkey ceremonies (React Native, W6a): the kernel calls the platform authenticator
 * itself, so PRF outputs never cross the channel. Covers create (with and without PRF at
 * registration), restore and its wallet-purpose check, unverified and cancelled ceremonies, and the
 * rule that each platform accepts only its own ceremony shape.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import type { Keystore, PasskeyAuthenticator, PasskeyResult } from "../src/platform.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";

const RP = { rpId: "wallet-harness.qntx.org", rpName: "Harness" };
const WALLET_SALT = "harness/wallet/v1";
const CREDENTIAL = new Uint8Array([7, 7, 7, 7]);
const PRF = new Uint8Array(32).map((_, i) => i + 1);

/** A keystore that seals by copying: these tests are about passkeys, not the hardware factor. */
const keystore: Keystore = {
  locale: "en",
  seal: async (_id, secret) => Promise.resolve(new Uint8Array(secret)),
  open: async (_id, sealed) => Promise.resolve(new Uint8Array(sealed)),
  authenticate: async () => Promise.resolve(),
  clear: async () => Promise.resolve(),
};

type Call =
  | { readonly op: "create"; readonly input: Parameters<PasskeyAuthenticator["create"]>[0] }
  | { readonly op: "get"; readonly input: Parameters<PasskeyAuthenticator["get"]>[0] };

/** Scripted authenticator: each call answers with the next queued result or failure. */
function fakeAuthenticator(answers: Array<Partial<PasskeyResult> | KernelError>) {
  const calls: Call[] = [];
  const answer = async (): Promise<PasskeyResult> => {
    await Promise.resolve();
    const next = answers.shift();
    if (next instanceof KernelError || next === undefined) {
      throw next ?? new Error("unscripted ceremony");
    }
    return {
      credentialId: new Uint8Array(CREDENTIAL),
      first: new Uint8Array(PRF),
      second: undefined,
      userHandle: undefined,
      synced: true,
      userVerified: true,
      ...next,
    };
  };
  const authenticator: PasskeyAuthenticator = {
    create: async (input) => {
      calls.push({ op: "create", input });
      return answer();
    },
    get: async (input) => {
      calls.push({ op: "get", input });
      return answer();
    },
  };
  return { authenticator, calls };
}

function okOf(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}

function walletOf(response: KernelResponse): Record<string, ProtocolValue> {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  const ok = response.ok as Record<string, ProtocolValue>;
  return ok["wallet"] as Record<string, ProtocolValue>;
}

const nativeHarness = (passkey: PasskeyAuthenticator): Harness =>
  createHarness({ keystore, passkey });

const create = async (h: Harness) => {
  await h.settle();
  return h.call("wallet.createWithPasskey", {
    ceremony: "kernel",
    ...RP,
    name: "alice",
    walletSalt: WALLET_SALT,
    factor: { kind: "hardware" },
  });
};

const restore = async (h: Harness) => {
  await h.settle();
  return h.call("wallet.restoreWithPasskey", {
    ceremony: "kernel",
    rpId: RP.rpId,
    walletSalt: WALLET_SALT,
    factor: { kind: "hardware" },
  });
};

/** The walletId the host-ceremony path derives from the same PRF output — the reference. */
async function hostWalletId(): Promise<ProtocolValue> {
  const h = createHarness();
  await h.settle();
  const response = await h.call("wallet.createWithPasskey", {
    ceremony: "host",
    credentialId: new Uint8Array(CREDENTIAL),
    prfWallet: new Uint8Array(PRF),
    synced: true,
    factor: { kind: "password", password: utf8ToBytes("correct horse battery staple") },
  });
  return walletOf(response)["walletId"] as ProtocolValue;
}

describe("kernel passkey ceremony: create", () => {
  it("registers a wallet-purpose credential and derives the same wallet as the host path", async () => {
    const { authenticator, calls } = fakeAuthenticator([{}]);
    const wallet = walletOf(await create(nativeHarness(authenticator)));
    expect(wallet["walletId"]).toBe(await hostWalletId());
    expect(wallet["backup"]).toBe("passkey");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.op).toBe("create");
    const input = call?.input as Parameters<PasskeyAuthenticator["create"]>[0];
    expect(input.rpId).toBe(RP.rpId);
    expect(input.rpName).toBe(RP.rpName);
    expect(input.userName).toBe("alice");
    expect(input.userId).toHaveLength(16);
    expect(input.userId[0]).toBe(0x01);
    expect(input.salts.first).toStrictEqual(utf8ToBytes(WALLET_SALT));
    expect(input.salts.second).toBeUndefined();
  });

  it("asserts the new credential once when registration returns no PRF output", async () => {
    const { authenticator, calls } = fakeAuthenticator([{ first: undefined }, {}]);
    const wallet = walletOf(await create(nativeHarness(authenticator)));
    expect(wallet["walletId"]).toBe(await hostWalletId());
    expect(calls.map((c) => c.op)).toStrictEqual(["create", "get"]);
    const get = calls[1]?.input as Parameters<PasskeyAuthenticator["get"]>[0];
    expect(get.allowCredentials).toStrictEqual([CREDENTIAL]);
  });

  it("a device-bound credential leaves the wallet without backup", async () => {
    const { authenticator } = fakeAuthenticator([{ synced: false }]);
    expect(walletOf(await create(nativeHarness(authenticator)))["backup"]).toBe("none");
  });

  it("an unverified or PRF-less ceremony is factor-unavailable and establishes nothing", async () => {
    for (const answer of [{ userVerified: false }, { first: new Uint8Array(16) }]) {
      const { authenticator } = fakeAuthenticator([answer]);
      const h = nativeHarness(authenticator);
      // oxlint-disable-next-line eslint/no-await-in-loop -- one kernel per scripted answer
      expect(errCode(await create(h))).toBe("factor-unavailable");
      // oxlint-disable-next-line eslint/no-await-in-loop -- status of the same kernel
      expect(errCode(await h.call("status"))).toBeUndefined();
    }
  });
});

describe("kernel passkey ceremony: restore", () => {
  it("asserts any credential for the RP and restores a wallet-purpose one", async () => {
    const userHandle = new Uint8Array(16).fill(9);
    userHandle[0] = 0x01;
    const { authenticator, calls } = fakeAuthenticator([{ userHandle }]);
    const wallet = walletOf(await restore(nativeHarness(authenticator)));
    expect(wallet["walletId"]).toBe(await hostWalletId());
    const get = calls[0]?.input as Parameters<PasskeyAuthenticator["get"]>[0];
    expect(calls[0]?.op).toBe("get");
    expect(get.allowCredentials).toBeUndefined();
  });

  it("rejects a credential of another purpose as wrong-passkey", async () => {
    const userHandle = new Uint8Array(16);
    userHandle[0] = 0x02;
    const { authenticator } = fakeAuthenticator([{ userHandle }]);
    expect(errCode(await restore(nativeHarness(authenticator)))).toBe("wrong-passkey");
  });

  it("a cancelled ceremony reports cancelled and leaves the vault uninitialized", async () => {
    const { authenticator } = fakeAuthenticator([new KernelError("cancelled", "user cancelled")]);
    const h = nativeHarness(authenticator);
    expect(errCode(await restore(h))).toBe("cancelled");
    await expect(h.call("status")).resolves.toMatchObject({ ok: { vault: "uninitialized" } });
  });
});

describe("ceremony shape follows the platform", () => {
  it("a kernel with an authenticator refuses host evidence", async () => {
    const { authenticator, calls } = fakeAuthenticator([]);
    const h = nativeHarness(authenticator);
    await h.settle();
    const response = await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: new Uint8Array(CREDENTIAL),
      prfWallet: new Uint8Array(PRF),
      synced: true,
      factor: { kind: "hardware" },
    });
    expect(errCode(response)).toBe("factor-unavailable");
    expect(calls).toStrictEqual([]);
  });

  it("a kernel without an authenticator refuses a kernel ceremony", async () => {
    const h = createHarness();
    await h.settle();
    const response = await h.call("wallet.restoreWithPasskey", {
      ceremony: "kernel",
      rpId: RP.rpId,
      walletSalt: WALLET_SALT,
      factor: { kind: "password", password: utf8ToBytes("correct horse battery staple") },
    });
    expect(errCode(response)).toBe("factor-unavailable");
  });
});

describe("kernel passkey ceremony: backup factor", () => {
  const BACKUP_SALT = "harness/backup/v1";

  it("enables with a new protection credential and restores by asserting the envelope's", async () => {
    const created = fakeAuthenticator([{}, {}]);
    const h = nativeHarness(created.authenticator);
    const session = okOf(await create(h)) as { session: string };
    await expect(
      h.call(
        "backup.enable",
        {
          verify: { kind: "hardware" },
          factors: [
            {
              kind: "passkey",
              ceremony: "kernel",
              ...RP,
              name: "Harness",
              backupSalt: BACKUP_SALT,
            },
          ],
        },
        session.session,
      ),
    ).resolves.toStrictEqual({ id: 2, ok: null });
    const enable = created.calls[1]?.input as Parameters<PasskeyAuthenticator["create"]>[0];
    expect(created.calls[1]?.op).toBe("create");
    expect(enable.userId[0]).toBe(0x02);
    expect(enable.salts.first).toStrictEqual(utf8ToBytes(BACKUP_SALT));
    const update = okOf(await h.call("backup.update", null, session.session)) as {
      envelope: string;
    };

    const restored = fakeAuthenticator([{}]);
    const fresh = nativeHarness(restored.authenticator);
    await fresh.settle();
    const result = await fresh.call("backup.restore", {
      envelope: update.envelope,
      backupFactor: { kind: "passkey", ceremony: "kernel", rpId: RP.rpId, backupSalt: BACKUP_SALT },
      factor: { kind: "hardware" },
    });
    expect(result).toMatchObject({ ok: { wallets: [{ origin: "passkey" }] } });
    const get = restored.calls[0]?.input as Parameters<PasskeyAuthenticator["get"]>[0];
    expect(get.allowCredentials).toStrictEqual([CREDENTIAL]);
    expect(get.salts.first).toStrictEqual(utf8ToBytes(BACKUP_SALT));
  });
});
