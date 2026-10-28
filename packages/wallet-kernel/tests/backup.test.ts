// Integration coverage for cloud backup (design/backup.mdx): enable retains a sealed BEK as the
// backup-key record; update rewrites the cloud envelope under it in one nonce draw; restore
// unwraps with a backup factor and merges — adopting the envelope's BEK only while establishing
// the vault.

import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";
import type { WalletErrorCode } from "@qntx/wallet/types";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";

const NSEC = (
  loadVectors("nip06.json") as {
    vectors: Array<{ readonly nsec: string; readonly publicKey: string }>;
  }
).vectors[0] ?? { nsec: "", publicKey: "" };

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
  await h.call("backup.enable", { verify: verifyPasskey(), factors }, session);
  const res = ok(await h.call("backup.update", null, session));
  return strField(res, "envelope");
}

async function statusBackup(h: Harness, session?: string): Promise<ProtocolValue> {
  const status = ok(await h.call("status", undefined, session));
  return field(status, "backup");
}

describe("backup.enable", () => {
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
      errCode(await h.call("backup.enable", { verify: bad, factors: [backupPasskeyF()] }, session)),
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
          "backup.enable",
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
  readonly id: string;
  readonly backupKeyHeader: string;
  readonly enable: { readonly factors: ReadonlyArray<Record<string, unknown>> };
  readonly envelopes: ReadonlyArray<string>;
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

  it("reproduces enable's record and both update envelopes byte for byte", async () => {
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

    ok(
      await h.call(
        "backup.enable",
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

    // The retained key's public header is the vector text verbatim.
    const image = await h.store.load();
    const keyRecord = mustFind(image.records, "backup-key", "default");
    expect(keyRecord.header).toBe(vector.backupKeyHeader);
    const backup = await statusBackup(h, session);
    expect(strField(backup, "id")).toBe(vector.id);

    for (const expected of vector.envelopes) {
      // Sequential by design: each update consumes exactly one recorded nonce draw.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const updated = ok(await h.call("backup.update", null, session));
      expect(strField(updated, "envelope")).toBe(expected);
    }

    const b = createHarness({ seed: 99 });
    await b.settle();
    const restored = ok(
      await b.call("backup.restore", {
        envelope: vector.envelopes[0],
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
    // Restoring into a fresh vault adopts the envelope's backup key.
    expect(strField(await statusBackup(b), "id")).toBe(vector.id);
  });
});

describe("backup enable/update/disable", () => {
  it("re-enable rotates the BEK and the public id", async () => {
    const h = createHarness({ seed: 81 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    await createBackupEnvelope(h, session, [backupPassword()]);
    const first = strField(await statusBackup(h, session), "id");

    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPassword()] },
        session,
      ),
    );
    const second = strField(await statusBackup(h, session), "id");
    expect(second).not.toBe(first);
    // The new BEK's envelope restores with the same backup factor.
    const res = ok(await h.call("backup.update", null, session));
    const b = createHarness({ seed: 82 });
    await b.settle();
    const restored = ok(
      await b.call("backup.restore", {
        envelope: strField(res, "envelope"),
        backupFactor: backupPassword(),
        factor: vaultPasswordFactor(),
      }),
    );
    expect(arrField(restored, "wallets")).toHaveLength(1);
  });

  it("update without enable is not-found", async () => {
    const h = createHarness({ seed: 83 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    expect(errCode(await h.call("backup.update", null, session))).toBe("not-found");
  });

  it("update picks up a new wallet and an imported key and the envelope restores", async () => {
    const a = createHarness({ seed: 84 });
    await a.settle();
    const { session } = await createPasskeyWallet(a);
    await createBackupEnvelope(a, session, [backupPassword()]);
    // Add a mnemonic wallet + a standalone nostr key, then update again.
    ok(
      await a.call(
        "wallet.importMnemonic",
        {
          mnemonic: utf8ToBytes("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"),
        },
        session,
      ),
    );
    const nsecRes = ok(
      await a.call(
        "nostr.importKey",
        { input: { kind: "nsec", nsec: utf8ToBytes(NSEC.nsec) } },
        session,
      ),
    );
    const keyId = strField(field(nsecRes, "key"), "publicKey");
    const updated = ok(await a.call("backup.update", null, session));
    const envelope = strField(updated, "envelope");
    const parsed = JSON.parse(envelope) as { header: string };
    const header = JSON.parse(parsed.header) as {
      wallets: Array<Record<string, unknown>>;
      importedNostrKeyCount: number;
    };
    expect(header.wallets).toHaveLength(2);
    expect(header.importedNostrKeyCount).toBe(1);

    const b = createHarness({ seed: 85 });
    await b.settle();
    const restored = ok(
      await b.call("backup.restore", {
        envelope,
        backupFactor: backupPassword(),
        factor: vaultPasswordFactor(),
      }),
    );
    expect(arrField(restored, "wallets")).toHaveLength(2);
    const keys = arrField(field(ok(await b.call("status")), "nostr"), "keys");
    expect(strField(at(keys, 0), "publicKey")).toBe(keyId);
  });

  it("merge restore never adopts the envelope's backup key", async () => {
    const a = createHarness({ seed: 86 });
    await a.settle();
    const { session } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPassword()]);
    const aId = strField(await statusBackup(a, session), "id");

    // Merge into a vault with backup enabled: it keeps its own backup key.
    const b = createHarness({ seed: 87 });
    await b.settle();
    const { session: bSession } = await createPasskeyWallet(b);
    await createBackupEnvelope(b, bSession, [backupPassword()]);
    const bId = strField(await statusBackup(b, bSession), "id");
    ok(await b.call("backup.restore", { envelope, backupFactor: backupPassword() }, bSession));
    expect(strField(await statusBackup(b, bSession), "id")).toBe(bId);
    expect(bId).not.toBe(aId);

    // Merge into a vault without backup: it stays off.
    const c = createHarness({ seed: 88 });
    await c.settle();
    const { session: cSession } = await createPasskeyWallet(c);
    ok(await c.call("backup.restore", { envelope, backupFactor: backupPassword() }, cSession));
    await expect(statusBackup(c, cSession)).resolves.toBeNull();
  });

  it("disable is idempotent and update then fails", async () => {
    const h = createHarness({ seed: 89 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    await createBackupEnvelope(h, session, [backupPassword()]);
    ok(await h.call("backup.disable", null, session));
    await expect(statusBackup(h, session)).resolves.toBeNull();
    ok(await h.call("backup.disable", null, session)); // second disable succeeds
    expect(errCode(await h.call("backup.update", null, session))).toBe("not-found");
  });

  it("update still works after a vault-factor rotation", async () => {
    const h = createHarness({ seed: 91 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    await createBackupEnvelope(h, session, [backupPassword()]);
    // Rotate the DEK: add a second vault factor — every record re-seals.
    ok(
      await h.call(
        "vault.addFactor",
        {
          verify: verifyPasskey(),
          factor: { kind: "password", password: new Uint8Array(utf8ToBytes("rotated password!")) },
        },
        session,
      ),
    );
    const res = ok(await h.call("backup.update", null, session));
    const b = createHarness({ seed: 92 });
    await b.settle();
    const restored = ok(
      await b.call("backup.restore", {
        envelope: strField(res, "envelope"),
        backupFactor: backupPassword(),
        factor: vaultPasswordFactor(),
      }),
    );
    expect(arrField(restored, "wallets")).toHaveLength(1);
  });

  it("a backup-key record with a stray id corrupts the image", async () => {
    const h = createHarness({ seed: 95 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    await createBackupEnvelope(h, session, [backupPassword()]);
    const image = await h.store.load();
    const record = mustFind(image.records, "backup-key", "default");
    await h.store.commit([{ op: "put-record", record: { ...record, id: "stray" } }]);
    const status = await h.call("status", undefined, session);
    expect(field(ok(status), "vault")).toBe("corrupted");
  });

  it("a locked snapshot still reports the backup id; a tampered header corrupts", async () => {
    const h = createHarness({ seed: 93 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    await createBackupEnvelope(h, session, [backupPassword()]);
    const id = strField(await statusBackup(h, session), "id");
    await h.call("vault.lock", null, session);
    const locked = await statusBackup(h);
    expect(strField(locked, "id")).toBe(id);

    // Tamper the backup-key header → corrupted image.
    const h2 = createHarness({ seed: 94 });
    await h2.settle();
    const { session: s2 } = await createPasskeyWallet(h2);
    await createBackupEnvelope(h2, s2, [backupPassword()]);
    const { store } = h2;
    const image = await store.load();
    const record = mustFind(image.records, "backup-key", "default");
    await store.commit([
      {
        op: "put-record",
        record: { ...record, header: JSON.stringify({ id: "zz" }) },
      },
    ]);
    const status = await h2.call("status", undefined, s2);
    expect(field(ok(status), "vault")).toBe("corrupted");
  });
});
