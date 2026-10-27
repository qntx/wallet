// Integration coverage for the cloud-backup envelope (design/backup.mdx): create seals secrets
// under a fresh BEK wrapped per factor; restore unwraps with a backup factor, verifies the
// authenticated header and merges records in one commit.

import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";
import type { WalletErrorCode } from "@qntx/wallet/types";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("11".repeat(32));
const PRF_WALLET = hexToBytes("22".repeat(32));
const PRF_BACKUP = hexToBytes("33".repeat(32));
const PASSWORD = utf8ToBytes("correct horse battery");

function ok(response: KernelResponse): ProtocolValue {
  if ("ok" in response) {
    return response.ok;
  }
  throw new Error(`expected ok, got ${JSON.stringify(response)}`);
}

function errCode(response: KernelResponse): WalletErrorCode {
  if ("err" in response) {
    return response.err.code;
  }
  throw new Error("expected err");
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const entry = (value as Record<string, ProtocolValue>)[key];
    if (entry !== undefined) {
      return entry;
    }
  }
  throw new Error(`missing field ${key}`);
}

function arrField(value: ProtocolValue, key: string): ReadonlyArray<ProtocolValue> {
  const v = field(value, key);
  if (!Array.isArray(v)) {
    throw new TypeError(`field ${key} is not an array`);
  }
  return v;
}

function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`field ${key} is not a string`);
  }
  return v;
}

function mustFind<T extends { readonly kind: string; readonly id: string }>(
  records: ReadonlyArray<T>,
  kind: string,
  id: string,
): T {
  const record = records.find((r) => r.kind === kind && r.id === id);
  if (record === undefined) {
    throw new Error(`missing ${kind} record ${id}`);
  }
  return record;
}

function at(values: ReadonlyArray<ProtocolValue>, index: number): ProtocolValue {
  const v = values[index];
  if (v === undefined) {
    throw new Error(`missing index ${index}`);
  }
  return v;
}

const TAMPERS: ReadonlyArray<readonly [string, (e: Record<string, unknown>) => void]> = [
  [
    "header",
    (e) => {
      e["header"] = `${String(e["header"])} `; // flips the authenticated text
    },
  ],
  [
    "payload",
    (e) => {
      const bytes = base64urlnopad.decode(String(e["payload"]));
      const [b30] = bytes.slice(30); // version byte of the sealed payload blob
      bytes[0] = 0x02;
      void b30;
      e["payload"] = base64urlnopad.encode(bytes);
    },
  ],
  [
    "factors",
    (e) => {
      const { factors } = e;
      if (Array.isArray(factors)) {
        const [first] = factors;
        if (typeof first === "object" && first !== null) {
          Reflect.set(first, "iterations", 599999); // fixed-iteration check fails → integrity
        }
      }
    },
  ],
  [
    "version",
    (e) => {
      e["version"] = 2;
    },
  ],
  [
    "extra-field",
    (e) => {
      e["unknown"] = 1;
    },
  ],
];

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF_VAULT),
});

const backupPassword = () => ({
  kind: "password" as const,
  password: new Uint8Array(PASSWORD),
});

const vaultPasswordFactor = () => ({
  kind: "password" as const,
  password: new Uint8Array(PASSWORD),
});

const vaultPasskeyFactor = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF_VAULT),
});

const backupPasskeyF = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prfBackup: new Uint8Array(PRF_BACKUP),
});

async function createPasskeyWallet(h: Harness) {
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      credentialId: CREDENTIAL_ID,
      prfWallet: PRF_WALLET,
      synced: true,
      factor: vaultPasskeyFactor(),
    }),
  );
  return {
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
}

async function createBackupEnvelope(
  h: Harness,
  session: string,
  factors: ReadonlyArray<unknown>,
): Promise<string> {
  const res = ok(await h.call("backup.create", { verify: verifyPasskey(), factors }, session));
  return strField(res, "envelope");
}

describe("backup.create", () => {
  it("requires a valid verify factor", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const bad = {
      kind: "passkey" as const,
      credentialId: CREDENTIAL_ID,
      prf: hexToBytes("99".repeat(32)),
    };
    expect(
      errCode(await h.call("backup.create", { verify: bad, factors: [backupPasskeyF()] }, session)),
    ).toBe("wrong-passkey");
  });

  it("requires an active session", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    void session;
    expect(
      errCode(
        await h.call(
          "backup.create",
          { verify: verifyPasskey(), factors: [backupPassword()] },
          "00".repeat(16),
        ),
      ),
    ).toBe("locked");
  });
});

describe("backup.restore", () => {
  it("restores into an uninitialized vault and opens a session", async () => {
    const a = createHarness({ seed: 7 });
    await a.settle();
    const { session, walletId } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPassword(), backupPasskeyF()]);

    const b = createHarness({ seed: 8 });
    await b.settle();
    const res = ok(
      await b.call("backup.restore", {
        envelope,
        backupFactor: backupPassword(),
        factor: vaultPasswordFactor(),
      }),
    );
    const wallets = arrField(res, "wallets");
    expect(wallets).toHaveLength(1);
    expect(strField(at(wallets, 0), "walletId")).toBe(walletId);
    const newSession = strField(res, "session");
    expect(newSession).toMatch(/^[0-9a-f]{32}$/);

    const status = field(ok(await b.call("status", undefined, newSession)), "vault");
    expect(status).toBe("unlocked");
  });

  it("restores an 18-word imported wallet with words:18 in its record", async () => {
    const a = createHarness({ seed: 71 });
    await a.settle();
    const created = ok(
      await a.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent",
        ),
        factor: vaultPasskeyFactor(),
      }),
    );
    const session = strField(created, "session");
    const walletId = strField(field(created, "wallet"), "walletId");
    const envelope = await createBackupEnvelope(a, session, [backupPassword()]);

    const b = createHarness({ seed: 72 });
    await b.settle();
    const res = ok(
      await b.call("backup.restore", {
        envelope,
        backupFactor: backupPassword(),
        factor: vaultPasswordFactor(),
      }),
    );
    expect(strField(at(arrField(res, "wallets"), 0), "walletId")).toBe(walletId);
    const image = await b.store.load();
    const entropyRecord = mustFind(image.records, "entropy", walletId);
    expect(field(JSON.parse(entropyRecord.header) as ProtocolValue, "words")).toBe(18);
  });

  it("marks a restored mnemonic wallet backup:none — the words were never shown here", async () => {
    const a = createHarness({ seed: 61 });
    await a.settle();
    const created = ok(
      await a.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        ),
        factor: vaultPasskeyFactor(),
      }),
    );
    const session = strField(created, "session");
    const walletId = strField(field(created, "wallet"), "walletId");
    expect(strField(field(created, "wallet"), "backup")).toBe("mnemonic");
    const envelope = await createBackupEnvelope(a, session, [backupPassword()]);

    const b = createHarness({ seed: 62 });
    await b.settle();
    const res = ok(
      await b.call("backup.restore", {
        envelope,
        backupFactor: backupPassword(),
        factor: vaultPasswordFactor(),
      }),
    );
    const wallets = arrField(res, "wallets");
    expect(strField(at(wallets, 0), "walletId")).toBe(walletId);
    expect(strField(at(wallets, 0), "backup")).toBe("none");
  });

  it("either factor restores the same envelope", async () => {
    const a = createHarness({ seed: 11 });
    await a.settle();
    const { session, walletId } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPassword(), backupPasskeyF()]);

    const viaPassword = createHarness({ seed: 12 });
    await viaPassword.settle();
    const r1 = ok(
      await viaPassword.call("backup.restore", {
        envelope,
        backupFactor: backupPassword(),
        factor: vaultPasswordFactor(),
      }),
    );
    expect(strField(field(field(r1, "wallets") as ProtocolValue[], "0") as never, "walletId")).toBe(
      walletId,
    );

    const viaPasskey = createHarness({ seed: 13 });
    await viaPasskey.settle();
    const r2 = ok(
      await viaPasskey.call("backup.restore", {
        envelope,
        backupFactor: backupPasskeyF(),
        factor: vaultPasskeyFactor(),
      }),
    );
    const ws2 = arrField(r2, "wallets");
    expect(strField(at(ws2, 0), "walletId")).toBe(walletId);
  });

  it("merges into an unlocked vault and skips the existing wallet", async () => {
    const a = createHarness({ seed: 21 });
    await a.settle();
    const { session, walletId } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPassword()]);

    const b = createHarness({ seed: 22 });
    await b.settle();
    const existing = await createPasskeyWallet(b);
    expect(existing.walletId).toBe(walletId);
    const res = ok(
      await b.call(
        "backup.restore",
        { envelope, backupFactor: backupPassword() },
        existing.session,
      ),
    );
    expect(field(res, "wallets")).toStrictEqual([]);
    const status = field(
      ok(await b.call("status", undefined, existing.session)),
      "wallets",
    ) as ProtocolValue[];
    expect(status).toHaveLength(1);
  });

  it("rejects a wrong password and writes nothing", async () => {
    const a = createHarness({ seed: 31 });
    await a.settle();
    const { session } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPassword()]);

    const b = createHarness({ seed: 32 });
    await b.settle();
    const res = await b.call("backup.restore", {
      envelope,
      backupFactor: { kind: "password", password: utf8ToBytes("wrong password!!") },
      factor: vaultPasswordFactor(),
    });
    expect(errCode(res)).toBe("wrong-password");
    expect(field(ok(await b.call("status")), "vault")).toBe("uninitialized");
  });

  it("rejects a wrong passkey PRF and an unknown credential", async () => {
    const a = createHarness({ seed: 41 });
    await a.settle();
    const { session } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPasskeyF()]);

    const wrong = await createHarness({ seed: 42 }).call("backup.restore", {
      envelope,
      backupFactor: {
        kind: "passkey",
        credentialId: CREDENTIAL_ID,
        prfBackup: hexToBytes("99".repeat(32)),
      },
      factor: vaultPasskeyFactor(),
    });
    expect(errCode(wrong)).toBe("wrong-passkey");

    const missing = await createHarness({ seed: 43 }).call("backup.restore", {
      envelope,
      backupFactor: {
        kind: "passkey",
        credentialId: utf8ToBytes("other-credential"),
        prfBackup: PRF_BACKUP,
      },
      factor: vaultPasskeyFactor(),
    });
    expect(errCode(missing)).toBe("not-found");
  });

  it.each(TAMPERS)("tampering with %s is integrity and writes nothing", async (_label, tamper) => {
    const a = createHarness({ seed: 51 });
    await a.settle();
    const { session } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPassword()]);
    const obj = JSON.parse(envelope) as Record<string, unknown>;
    tamper(obj);

    const b = createHarness({ seed: 52 });
    await b.settle();
    const res = await b.call("backup.restore", {
      envelope: JSON.stringify(obj),
      backupFactor: backupPassword(),
      factor: vaultPasswordFactor(),
    });
    expect(errCode(res)).toBe("integrity");
    expect(field(ok(await b.call("status")), "vault")).toBe("uninitialized");
  });
});

type BackupVector = {
  readonly inputs: {
    readonly credentialIdHex: string;
    readonly prfVault: string;
    readonly prfWallet: string;
    readonly prfBackup: string;
    readonly password: string;
    readonly start: number;
  };
  readonly draws: ReadonlyArray<{ readonly length: number; readonly bytes: string }>;
  readonly walletId: string;
  readonly envelope: string;
};

function makeReplay(
  draws: ReadonlyArray<{ readonly length: number; readonly bytes: string }>,
): (length: number) => Uint8Array {
  const queue = draws.map((d) => hexToBytes(d.bytes));
  let cursor = 0;
  return (length: number): Uint8Array => {
    const next = queue[cursor++];
    if (next === undefined) {
      throw new Error(`draw ${cursor}: queue exhausted at length ${length}`);
    }
    if (next.length !== length) {
      throw new Error(`draw ${cursor}: expected ${next.length}, got ${length}`);
    }
    return new Uint8Array(next);
  };
}

describe("backup vector", () => {
  const vector = loadVectors("backup.json") as BackupVector;

  it("rebuilds the envelope byte for byte from recorded draws, then restores", async () => {
    const replay = makeReplay(vector.draws);
    const { inputs } = vector;
    const credentialId = hexToBytes(inputs.credentialIdHex);
    const prfVault = hexToBytes(inputs.prfVault);
    const prfBackup = hexToBytes(inputs.prfBackup);

    const h = createHarness({ random: replay, start: inputs.start });
    await h.settle();
    const res = ok(
      await h.call("wallet.createWithPasskey", {
        credentialId,
        prfWallet: hexToBytes(inputs.prfWallet),
        synced: true,
        factor: {
          kind: "passkey",
          credentialId,
          prf: new Uint8Array(prfVault),
        },
      }),
    );
    const session = strField(res, "session");
    expect(strField(field(res, "wallet"), "walletId")).toBe(vector.walletId);

    const created = ok(
      await h.call(
        "backup.create",
        {
          verify: {
            kind: "passkey",
            credentialId,
            prf: new Uint8Array(prfVault),
          },
          factors: [
            { kind: "password", password: utf8ToBytes(inputs.password) },
            {
              kind: "passkey",
              credentialId,
              prfBackup: new Uint8Array(prfBackup),
            },
          ],
        },
        session,
      ),
    );
    expect(strField(created, "envelope")).toBe(vector.envelope);

    const b = createHarness({ seed: 99 });
    await b.settle();
    const restored = ok(
      await b.call("backup.restore", {
        envelope: vector.envelope,
        backupFactor: {
          kind: "passkey",
          credentialId,
          prfBackup: new Uint8Array(prfBackup),
        },
        factor: {
          kind: "passkey",
          credentialId,
          prf: new Uint8Array(prfVault),
        },
      }),
    );
    const wallets = arrField(restored, "wallets");
    expect(strField(at(wallets, 0), "walletId")).toBe(vector.walletId);
  });
});
