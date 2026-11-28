import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad, bech32 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { Keys, KeysSigner, nobleBackend, npubEncode, verifyEvent } from "@qntx/nostr";
import type { NostrBackend, Event } from "@qntx/nostr";
import { decode as nip19Decode } from "@qntx/nostr/nips/nip19";
import { decrypt as nip49Decrypt } from "@qntx/nostr/nips/nip49";
import { createRumor, wrap as nip59Wrap } from "@qntx/nostr/nips/nip59";
import type { KernelEvent, ProtocolValue, WalletErrorCode } from "@qntx/wallet/protocol";
import type { FactorInfo, StatusPayload as StatusT } from "@qntx/wallet/types";

import { KernelError } from "../src/errors.ts";
import { NOSTR_KEY_KIND, encodeNostrKeyHeader } from "../src/modules/nostr/record.ts";
import type { Pbkdf2, VaultAnchor } from "../src/platform.ts";
import { Secret, wipe } from "../src/secret/secret.ts";
import { createMemoryAnchor, readAnchor } from "../src/vault/anchor.ts";
import { recordContext, seal } from "../src/vault/envelope.ts";
import {
  factorPublicKey,
  passkeyKek,
  passwordKek,
  unwrapDek,
  wrapDek,
} from "../src/vault/factors.ts";
import { encodeHeader, parsePasswordFactorHeader } from "../src/vault/headers.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type {
  RecordStore,
  StoredFactor,
  StoredRecord,
  VaultImage,
  VaultMeta,
} from "../src/vault/store.ts";
import { VAULT_FORMAT } from "../src/vault/store.ts";
import { openRecord } from "../src/vault/vault.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness, nonEchoing, seededRandom } from "./harness.ts";
import { kernelError, loadVectors, subtlePbkdf2 } from "./helpers.ts";

const passkeyVector = loadVectors("passkey.json") as {
  vector: {
    prf: string;
    mnemonic: string;
    publicKey: string;
    privateKey: string;
    walletId: string;
  };
};
const syncKeyVector = loadVectors("sync-key.json") as {
  vector: { path: string; privateKey: string; publicKey: string };
};
const nip06 = loadVectors("nip06.json") as {
  vectors: Array<{ mnemonic: string; privateKey: string; publicKey: string; nsec: string }>;
};

const PRF_WALLET = hexToBytes(passkeyVector.vector.prf);
const PRF_VAULT = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PASSWORD = utf8ToBytes("correct horse battery");

function ncryptsecPayload(encoded: string): Uint8Array {
  return new Uint8Array(bech32.fromWords(bech32.decode(encoded, 5000).words));
}

/** Re-encodes a mutated NIP-49 payload — builds malformed or over-limit import inputs. */

/** The NIP-49 key security byte of an exported `ncryptsec` (offset 42 of the 91-byte payload). */
function exportedKsb(ncryptsecBytes: ProtocolValue): number {
  if (!(ncryptsecBytes instanceof Uint8Array)) {
    throw new TypeError("expected bytes");
  }
  return must(ncryptsecPayload(new TextDecoder().decode(ncryptsecBytes)).at(42));
}

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function errPayload(response: KernelResponse): { code: WalletErrorCode; retryAt?: number } {
  if (!("err" in response)) {
    throw new Error("expected err, got ok");
  }
  return response.err;
}

function errCode(response: KernelResponse): WalletErrorCode {
  return errPayload(response).code;
}

/** A store whose `load` rejects while `broken()` holds — used to drive the poisoned-store path. */
function failingLoad(store: RecordStore, broken: () => boolean): RecordStore["load"] {
  return async () => {
    if (broken()) {
      throw new KernelError("integrity", "corrupt store");
    }
    return store.load();
  };
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  // Arrays and Uint8Array both carry Symbol.iterator; plain records do not.
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}

/** Whether a plain-object protocol value carries `key` as an own property. */

function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`field ${key}: not a string`);
  }
  return v;
}

function bytesField(value: ProtocolValue, key: string): Uint8Array {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`field ${key}: not bytes`);
  }
  return v;
}

function listField(value: ProtocolValue, key: string): ReadonlyArray<ProtocolValue> {
  const v = field(value, key);
  if (!Array.isArray(v)) {
    throw new TypeError(`field ${key}: not an array`);
  }
  return v;
}

function numField(value: ProtocolValue, key: string): number {
  const v = field(value, key);
  if (typeof v !== "number") {
    throw new TypeError(`field ${key}: not a number`);
  }
  return v;
}

function intList(value: ProtocolValue, key: string): number[] {
  return listField(value, key).map(numOf);
}

function numOf(v: ProtocolValue): number {
  if (typeof v !== "number") {
    throw new TypeError("not a number");
  }
  return v;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a defined value");
  }
  return value;
}

function factorId(factor: FactorInfo | undefined): string {
  if (factor === undefined || factor.kind === "hardware") {
    throw new Error("expected a factor id");
  }
  return factor.id;
}

function lockReasons(events: ReadonlyArray<KernelEvent>): string[] {
  return events.flatMap((e) => (e.event === "locked" ? [e.reason] : []));
}

function nsecData(decoded: ReturnType<typeof nip19Decode>): Uint8Array {
  if (decoded.type !== "nsec") {
    throw new Error(`expected nsec, got ${decoded.type}`);
  }
  return decoded.data;
}

function lastStatus(h: ReturnType<typeof createHarness>): StatusT {
  for (let i = h.events.length - 1; i >= 0; i--) {
    const event = h.events[i];
    if (event !== undefined && event.event === "status") {
      return event.status;
    }
  }
  throw new Error("no status event yet");
}

/** The stored meta row, asserted present. */
async function storedMeta(store: RecordStore): Promise<VaultMeta> {
  const image = await store.load();
  return must(image.meta);
}

/** The persisted wrong-password counter — it lives in the anchor, outside the store. */
async function storedFailedAttempts(anchor: VaultAnchor): Promise<number> {
  const state = await readAnchor(anchor);
  return state.failedAttempts;
}

/** "ok" or the error code — lifted out so test bodies carry no conditionals. */
function codeOf(response: KernelResponse): string {
  return "err" in response ? response.err.code : "ok";
}

/** A store wrapper that fails every `load` while `broken` holds true. */
function flakyLoad(store: RecordStore, broken: { current: boolean }): RecordStore {
  return {
    ...store,
    load: async () => {
      if (broken.current) {
        throw new Error("transient io");
      }
      return store.load();
    },
  };
}

/** A store wrapper that fails every `commit` while `broken` holds true. */
function flakyCommit(store: RecordStore, broken: { current: boolean }): RecordStore {
  return {
    ...store,
    commit: async (ops) => {
      if (broken.current) {
        throw new Error("quota exceeded");
      }
      return store.commit(ops);
    },
  };
}

/** A meta row as written by a vault init, with overridable fields for health tests. */
function metaOf(overrides?: Partial<VaultMeta>): VaultMeta {
  return {
    format: VAULT_FORMAT,
    revision: 1,
    keyId: "ab".repeat(16),
    ...overrides,
  };
}

// A factory, not a constant: the kernel wipes a factor's secret bytes while consuming them, so a
// wire factor must never be shared between calls.
function passkeyFactor(): { kind: "passkey"; credentialId: Uint8Array; prf: Uint8Array } {
  return {
    kind: "passkey",
    credentialId: new Uint8Array(CREDENTIAL_ID),
    prf: new Uint8Array(PRF_VAULT),
  };
}

/**
 * A fresh kernel over the same store — what a host-side lock + worker respawn looks like from the
 * kernel's side. The old harness stays subscribed (a terminated worker's ghost) but is inert for
 * the test's purposes.
 */
function respawn(h: Harness, wrapStore?: (store: RecordStore) => RecordStore): Harness {
  return createHarness({ store: h.store, wrapStore, anchor: h.anchor });
}

async function createPasskeyWallet(h: ReturnType<typeof createHarness>) {
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

/** Creation no longer derives keys: tests get the group-0 key explicitly. */
async function importNip06Wallet(h: ReturnType<typeof createHarness>) {
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
      factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
    }),
  );
  return {
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
}

async function deriveKey(
  h: ReturnType<typeof createHarness>,
  session: string,
  walletId: string,
  index = 0,
): Promise<string> {
  const res = ok(await h.call("nostr.deriveKey", { walletId, index }, session));
  return strField(res, "publicKey");
}

describe("kernel entry", () => {
  it("startKernel passes its ES6 block-scoping check under correct closure semantics", () => {
    // startKernel throws on a runtime that shares loop-scoped bindings (Hermes compiled
    // without -Xes6-block-scoping); Node's correct semantics must not trip it.
    expect(() => createHarness()).not.toThrow();
  });
});

describe("create / import", () => {
  it("creates a passkey wallet matching the vector and opens a session", async () => {
    const h = createHarness();
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({ status: "uninitialized" });

    const { session, walletId } = await createPasskeyWallet(h);
    expect(session).toMatch(/^[0-9a-f]{32}$/);
    expect(walletId).toBe(passkeyVector.vector.walletId);
    const publicKey = await deriveKey(h, session, walletId);
    expect(publicKey).toBe(passkeyVector.vector.publicKey);
    expect(npubEncode(publicKey)).toMatch(/^npub1/);

    const status = lastStatus(h);
    expect(status.vault.status).toBe("unlocked");
    expect(status.wallets[0]?.walletId).toBe(passkeyVector.vector.walletId);
    expect(status.wallets[0]).toMatchObject({ backup: "passkey" });
    expect(status.nostr.keys[0]?.publicKey).toBe(publicKey);
    expect(status.factors).toHaveLength(1);
  });

  it("rejects a duplicate restore with already-exists", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    expect(
      errCode(
        await h.call(
          "wallet.restoreWithPasskey",
          {
            ceremony: "host",
            credentialId: CREDENTIAL_ID,
            prfWallet: new Uint8Array(PRF_WALLET),
            synced: true,
          },
          session,
        ),
      ),
    ).toBe("already-exists");
  });

  it("imports a NIP-06 mnemonic wallet and derives group-0 key", async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    const publicKey = await deriveKey(h, session, walletId);
    expect(publicKey).toBe(nip06.vectors[0]!.publicKey);
  });

  it("restore reports the credential's sync state", async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.restoreWithPasskey", {
        ceremony: "host",
        credentialId: CREDENTIAL_ID,
        prfWallet: new Uint8Array(PRF_WALLET),
        synced: false,
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    expect(strField(field(res, "wallet"), "backup")).toBe("none");
  });

  it("mnemonic creation and import report 'mnemonic'", async () => {
    const h = createHarness();
    await h.settle();
    const imported = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    expect(strField(field(imported, "wallet"), "backup")).toBe("mnemonic");
  });

  it("exportMnemonic upgrades backup to 'mnemonic'; a second export commits nothing", async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.createWithPasskey", {
        ceremony: "host",
        credentialId: CREDENTIAL_ID,
        prfWallet: new Uint8Array(PRF_WALLET),
        synced: false,
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    expect(strField(field(res, "wallet"), "backup")).toBe("none");
    // kek derivation wipes `prf` — a verify factor is single-use, build one per call.
    const verify = () => ({
      kind: "passkey" as const,
      credentialId: CREDENTIAL_ID,
      prf: new Uint8Array(PRF_VAULT),
    });

    const metaBefore = await storedMeta(h.store);
    const exported = ok(
      await h.call("wallet.exportMnemonic", { verify: verify(), walletId }, session),
    );
    expect(new TextDecoder().decode(bytesField(exported, "mnemonic"))).toBe(
      passkeyVector.vector.mnemonic,
    );
    await h.settle();
    expect(lastStatus(h).wallets[0]).toMatchObject({ backup: "mnemonic" });
    const metaAfter = await storedMeta(h.store);
    expect(metaAfter.revision).toBe(metaBefore.revision + 1);

    // Already "mnemonic": the second export answers from the same record without a commit.
    ok(await h.call("wallet.exportMnemonic", { verify: verify(), walletId }, session));
    const metaFinal = await storedMeta(h.store);
    expect(metaFinal.revision).toBe(metaBefore.revision + 1);

    // The re-sealed record still opens after a respawn.
    const h2 = respawn(h);
    await h2.settle();
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session2 = strField(unlocked, "session");
    expect(lastStatus(h2).wallets[0]).toMatchObject({ backup: "mnemonic" });
    const again = ok(
      await h2.call("wallet.exportMnemonic", { verify: verify(), walletId }, session2),
    );
    expect(new TextDecoder().decode(bytesField(again, "mnemonic"))).toBe(
      passkeyVector.vector.mnemonic,
    );
  });
});

describe("wrong passkey errors", () => {
  it("unlock with an unknown credential id is wrong-passkey, not integrity", async () => {
    const h = createHarness();
    await h.settle();
    await createPasskeyWallet(h);
    const h2 = respawn(h);
    await h2.settle();
    expect(
      errCode(
        await h2.call("vault.unlock", {
          factor: {
            kind: "passkey",
            credentialId: utf8ToBytes("another-credential"),
            prf: new Uint8Array(32),
          },
        }),
      ),
    ).toBe("wrong-passkey");
  });

  it("unlock with a credential whose PRF misses the factor is wrong-passkey", async () => {
    const h = createHarness();
    await h.settle();
    await createPasskeyWallet(h);
    const h2 = respawn(h);
    await h2.settle();
    expect(
      errCode(
        await h2.call("vault.unlock", {
          factor: {
            kind: "passkey",
            credentialId: CREDENTIAL_ID,
            prf: new Uint8Array(32).fill(9),
          },
        }),
      ),
    ).toBe("wrong-passkey");
    // The vault is intact: the right credential still unlocks it.
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    expect(strField(unlocked, "session")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("verifyFactor with a wrong passkey is wrong-passkey", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    expect(
      errCode(
        await h.call(
          "wallet.exportMnemonic",
          {
            verify: {
              kind: "passkey",
              credentialId: CREDENTIAL_ID,
              prf: new Uint8Array(32).fill(9),
            },
            walletId: "0f".repeat(8),
          },
          session,
        ),
      ),
    ).toBe("wrong-passkey");
    expect(lastStatus(h).vault.status).toBe("unlocked"); // a wrong factor is not corruption
  });
});

describe("nostr record integrity", () => {
  it("a record whose key does not match its id latches the vault corrupted", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    // Rebuild the DEK through the stored passkey factor, then seal a derived-key record
    // under an id that is not the key's public key. The seal authenticates fine — only the
    // id/public-key check can catch it.
    const image = await h.store.load();
    const stored = must(image.factors.find((f) => f.kind === "passkey"));
    const kek = passkeyKek(new Uint8Array(PRF_VAULT), CREDENTIAL_ID);
    const dek = unwrapDek(kek, stored);
    wipe(kek);
    try {
      const secretKey = hexToBytes("ab".repeat(32));
      const { publicKey } = Keys.fromSecretKey(secretKey);
      const wrongId = "cd".repeat(32);
      expect(publicKey).not.toBe(wrongId);
      const header = encodeNostrKeyHeader({
        publicKey,
        walletId: "0f".repeat(8),
        index: 0,
        createdAt: 1,
      });
      const sealed = dek.use((bytes) =>
        seal(
          bytes,
          secretKey,
          recordContext(NOSTR_KEY_KIND, wrongId),
          header,
          seededRandom(7).random,
        ),
      );
      await h.store.commit([
        { op: "put-record", record: { kind: NOSTR_KEY_KIND, id: wrongId, header, sealed } },
      ]);
      await h.settle();
      expect(lastStatus(h).vault.status).toBe("corrupted");
      expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
        "integrity",
      );
    } finally {
      dek.wipe();
    }
  });
});

describe("mnemonic draft", () => {
  it("keeps the draft on wrong answers and completes on right answers", async () => {
    const h = createHarness();
    await h.settle();
    const created = ok(
      await h.call("wallet.createMnemonic", {
        words: 12,
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const draft = strField(created, "draft");
    const quiz = intList(created, "quiz");
    const words = new TextDecoder().decode(bytesField(created, "words")).split(" ");
    expect(quiz).toHaveLength(3);
    expect(new Set(quiz).size).toBe(3);

    const wrong = quiz.map(() => utf8ToBytes("abandon"));
    expect(errCode(await h.call("wallet.confirmMnemonic", { draft, answers: wrong }))).toBe(
      "invalid-input",
    );

    const right = quiz.map((p) => utf8ToBytes(words[p]!));
    const res = ok(await h.call("wallet.confirmMnemonic", { draft, answers: right }));
    expect(strField(res, "session")).toMatch(/^[0-9a-f]{32}$/);
    expect(lastStatus(h).vault.status).toBe("unlocked");
    expect(lastStatus(h).wallets[0]).toMatchObject({ backup: "mnemonic" });
  });

  it("discards the draft", async () => {
    const h = createHarness();
    await h.settle();
    const created = ok(
      await h.call("wallet.createMnemonic", {
        words: 12,
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const draft = strField(created, "draft");
    expect(ok(await h.call("wallet.discardMnemonic", { draft }))).toBeNull();
    expect(
      errCode(
        await h.call("wallet.confirmMnemonic", {
          draft,
          answers: [utf8ToBytes("a"), utf8ToBytes("b"), utf8ToBytes("c")],
        }),
      ),
    ).toBe("not-found");
  });
});

describe("nostr operations", () => {
  it("derives keys, discovers pubkeys, and rejects duplicate derivation", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const pk0 = await deriveKey(h, session, walletId);

    const discovered = listField(
      ok(await h.call("nostr.discover", { walletId, from: 0, count: 3 }, session)),
      "keys",
    );
    expect(discovered).toHaveLength(3);
    expect(strField(must(discovered[0]), "publicKey")).toBe(pk0);
    expect(numField(must(discovered[1]), "index")).toBe(1);

    const derived = ok(await h.call("nostr.deriveKey", { walletId, index: 1 }, session));
    expect(strField(derived, "publicKey")).toBe(strField(must(discovered[1]), "publicKey"));
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 1 }, session))).toBe(
      "already-exists",
    );
    expect(
      errCode(await h.call("nostr.deriveKey", { walletId: "0000000000000000", index: 0 }, session)),
    ).toBe("not-found");
  });

  it("signs events that verify", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const publicKey = await deriveKey(h, session, walletId);
    const event = ok(
      await h.call(
        "nostr.signEvent",
        {
          publicKey,
          event: { kind: 1, created_at: 1_700_000_001, tags: [], content: "gm" },
        },
        session,
      ),
    ) as unknown as Event;
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(publicKey);
  });

  it("round-trips nip04 and nip44 between two keys", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const alice = await deriveKey(h, session, walletId);
    const bob = strField(
      ok(await h.call("nostr.deriveKey", { walletId, index: 7 }, session)),
      "publicKey",
    );
    const c44 = ok(
      await h.call("nostr.nip44Encrypt", { publicKey: alice, peer: bob, text: "hello" }, session),
    );
    const p44 = ok(
      await h.call(
        "nostr.nip44Decrypt",
        { publicKey: bob, peer: alice, text: c44 as string },
        session,
      ),
    );
    expect(p44).toBe("hello");

    const c04 = ok(
      await h.call("nostr.nip04Encrypt", { publicKey: alice, peer: bob, text: "hi" }, session),
    );
    const p04 = ok(
      await h.call(
        "nostr.nip04Decrypt",
        { publicKey: bob, peer: alice, text: c04 as string },
        session,
      ),
    );
    expect(p04).toBe("hi");
  });

  it("unwraps gift wraps and isolates corrupted items", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const publicKey = await deriveKey(h, session, walletId);

    const sender = new KeysSigner(Keys.generate());
    const rumor = createRumor(await sender.getPublicKey(), { kind: 14, content: "secret dm" });
    const wrapped = await nip59Wrap(sender, publicKey, rumor);
    const res = listField(
      ok(
        await h.call(
          "nostr.unwrapGiftWraps",
          { publicKey, events: [wrapped, { ...wrapped, content: "broken" }] },
          session,
        ),
      ),
      "results",
    );
    expect(res).toHaveLength(2);
    const [first, second] = res;
    expect(first).toHaveProperty("ok");
    expect(second).toHaveProperty("err");
  });

  it("removes a derived key by public key", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const key = strField(
      ok(await h.call("nostr.deriveKey", { walletId, index: 9 }, session)),
      "publicKey",
    );
    expect(ok(await h.call("nostr.removeKey", { publicKey: key }, session))).toBeNull();
    expect(errCode(await h.call("nostr.removeKey", { publicKey: key }, session))).toBe("not-found");
  });
});

describe("nostr sync key", () => {
  const syncEvent = () => ({ kind: 30078, created_at: 1, tags: [["d", "meta"]], content: "x" });

  async function syncPub(h: ReturnType<typeof createHarness>, session: string, walletId: string) {
    return strField(ok(await h.call("nostr.syncKey", { walletId }, session)), "publicKey");
  }

  it("derives and seals a dedicated key, idempotent and independent of identities", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const pub = await syncPub(h, session, walletId);
    expect(pub).toMatch(/^[0-9a-f]{64}$/);
    // A second call answers the same record, never a second derivation.
    await expect(syncPub(h, session, walletId)).resolves.toBe(pub);
    // It differs from every identity index — identity 0 is not the sync key.
    expect(pub).not.toBe(await deriveKey(h, session, walletId, 0));
  });

  it("matches the independent m/44'/1237'/2147483647'/0/0 vector", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await importNip06Wallet(h);
    await expect(syncPub(h, session, walletId)).resolves.toBe(syncKeyVector.vector.publicKey);
  });

  it("is absent from the status snapshot and from the backup payload", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    // Backup still enables on a fresh vault — the sync record below must not change that.
    const pub = await syncPub(h, session, walletId);
    expect(lastStatus(h).nostr.keys).toHaveLength(0); // sync keys never list
    const image = await h.store.load();
    expect(image.records.some((r) => r.kind === "nostr-sync-key")).toBe(true);
    ok(
      await h.call(
        "backup.enable",
        {
          verify: passkeyFactor(),
          factors: [
            {
              kind: "passkey",
              ceremony: "host",
              credentialId: CREDENTIAL_ID,
              prfBackup: new Uint8Array(32).fill(0x33),
            },
          ],
        },
        session,
      ),
    );
    expect(lastStatus(h).nostr.keys.map((k) => k.publicKey)).not.toContain(pub);
  });

  it("signs only kind-30078 events and encrypts to itself", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const pub = await syncPub(h, session, walletId);
    expect(
      errCode(
        await h.call(
          "nostr.syncSign",
          { walletId, event: { kind: 1, created_at: 1, tags: [], content: "x" } },
          session,
        ),
      ),
    ).toBe("invalid-input");
    const signed = ok(await h.call("nostr.syncSign", { walletId, event: syncEvent() }, session));
    expect(strField(signed, "pubkey")).toBe(pub);
    const sealed = ok(await h.call("nostr.syncEncrypt", { walletId, text: "meta" }, session));
    expect(sealed).toMatch(/^[0-9a-z+/=_-]+$/i);
    const plain = ok(
      await h.call("nostr.syncDecrypt", { walletId, text: sealed as string }, session),
    );
    expect(plain).toBe("meta");
    // A NIP-44 payload sealed by another sender does not decrypt.
    const foreign = await new KeysSigner(Keys.generate()).nip44Encrypt(pub, "foreign");
    expect(
      errCode(await h.call("nostr.syncDecrypt", { walletId, text: foreign }, session)),
    ).toBeDefined();
  });

  it("is not exportable, is forgotten on wallet delete and disposed on lock", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const pub = await syncPub(h, session, walletId);
    // exportKey only reaches nostr-key records — the sync key is not-found there.
    expect(
      errCode(
        await h.call(
          "nostr.exportKey",
          {
            verify: {
              kind: "passkey",
              credentialId: CREDENTIAL_ID,
              prf: new Uint8Array(PRF_VAULT),
            },
            publicKey: pub,
            format: { kind: "nsec" },
          },
          session,
        ),
      ),
    ).toBe("not-found");
    // The idle timer disposes the pooled signer; a sign after re-unlock claims it again.
    h.advance(61_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(errCode(await h.call("nostr.syncSign", { walletId, event: syncEvent() }, session))).toBe(
      "locked",
    );
    const unlocked = strField(
      ok(
        await h.call("vault.unlock", {
          factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
        }),
      ),
      "session",
    );
    // Deleting the wallet removes its sync record atomically.
    ok(
      await h.call(
        "wallet.delete",
        {
          verify: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
          walletId,
        },
        unlocked,
      ),
    );
    const after = await h.store.load();
    expect(after.records.some((r) => r.kind === "nostr-sync-key")).toBe(false);
  });
});

describe("exports and data keys", () => {
  it("exports the mnemonic and nostr keys", { timeout: 30_000 }, async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const publicKey = await deriveKey(h, session, walletId);
    const verify = {
      kind: "passkey",
      credentialId: CREDENTIAL_ID,
      prf: new Uint8Array(PRF_VAULT),
    };

    const exported = ok(await h.call("wallet.exportMnemonic", { verify, walletId }, session));
    expect(new TextDecoder().decode(bytesField(exported, "mnemonic"))).toBe(
      passkeyVector.vector.mnemonic,
    );

    const nsecBytes = ok(
      await h.call(
        "nostr.exportKey",
        {
          verify: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
          publicKey,
          format: { kind: "nsec" },
        },
        session,
      ),
    );
    const decoded = nip19Decode(new TextDecoder().decode(nsecBytes as Uint8Array));
    expect(decoded.type).toBe("nsec");
    expect(bytesToHex(nsecData(decoded))).toBe(passkeyVector.vector.privateKey);

    const ncryptBytes = ok(
      await h.call(
        "nostr.exportKey",
        {
          verify: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
          publicKey,
          format: { kind: "ncryptsec", password: utf8ToBytes("exportpw1234") },
        },
        session,
      ),
    );
    const sk = await nip49Decrypt(
      new TextDecoder().decode(ncryptBytes as Uint8Array),
      "exportpw1234",
      { maxLogN: 20 },
    );
    expect(Keys.fromSecretKey(sk).publicKey).toBe(publicKey);
  });

  it("data keys are stable across lock/unlock", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const first = ok(await h.call("dataKeys.get", { purpose: "meowl-db" }, session));
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first as Uint8Array).toHaveLength(32);
    const again = ok(await h.call("dataKeys.get", { purpose: "meowl-db" }, session));
    expect(bytesToHex(again as Uint8Array)).toBe(bytesToHex(first as Uint8Array));

    // Lock = the host killed the worker; a fresh kernel over the same store is the respawn.
    const h2 = respawn(h);
    await h2.settle();
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session2 = strField(unlocked, "session");
    const afterLock = ok(await h2.call("dataKeys.get", { purpose: "meowl-db" }, session2));
    expect(bytesToHex(afterLock as Uint8Array)).toBe(bytesToHex(first as Uint8Array));
  });
});

describe("factors, lock, reset", () => {
  it("adds and removes a password factor; cannot remove the last", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const verify = { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) };
    const added = ok(
      await h.call(
        "vault.addFactor",
        { verify, factor: { kind: "password", password: new Uint8Array(PASSWORD) } },
        session,
      ),
    );
    const addedId = strField(added, "id");
    expect(strField(added, "kind")).toBe("password");
    expect(lastStatus(h).factors).toHaveLength(2);

    // The new password factor can unlock after a lock — a fresh kernel over the same store.
    const h2 = respawn(h);
    await h2.settle();
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const session2 = strField(unlocked, "session");
    expect(lastStatus(h2).vault.status).toBe("unlocked");

    // Removing with password verify works; the last factor cannot be removed.
    expect(
      ok(
        await h2.call(
          "vault.removeFactor",
          { verify: { kind: "password", password: new Uint8Array(PASSWORD) }, id: addedId },
          session2,
        ),
      ),
    ).toBeNull();
    const lastId = factorId(lastStatus(h2).factors[0]);
    expect(
      errCode(
        await h2.call(
          "vault.removeFactor",
          {
            verify: {
              kind: "passkey",
              credentialId: CREDENTIAL_ID,
              prf: new Uint8Array(PRF_VAULT),
            },
            id: lastId,
          },
          session2,
        ),
      ),
    ).toBe("invalid-input");
  });

  it("changes the password: addFactor replaces the single password factor atomically", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const verify = { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) };
    ok(
      await h.call(
        "vault.addFactor",
        {
          verify,
          factor: { kind: "password", password: utf8ToBytes("first correct horse") },
        },
        session,
      ),
    );
    // Change password: verify with the old password, add a new password factor.
    const changed = ok(
      await h.call(
        "vault.addFactor",
        {
          verify: { kind: "password", password: utf8ToBytes("first correct horse") },
          factor: { kind: "password", password: utf8ToBytes("second battery staple") },
        },
        session,
      ),
    );
    const passwordFactors = lastStatus(h).factors.filter((f) => f.kind === "password");
    expect(passwordFactors).toHaveLength(1);
    expect(factorId(passwordFactors[0])).toBe(strField(changed, "id"));

    const h2 = respawn(h);
    await h2.settle();
    // The old password is a normal wrong-password failure; the new one opens the vault.
    expect(
      errCode(
        await h2.call("vault.unlock", {
          factor: { kind: "password", password: utf8ToBytes("first correct horse") },
        }),
      ),
    ).toBe("wrong-password");
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "password", password: utf8ToBytes("second battery staple") },
      }),
    );
    expect(strField(unlocked, "session")).toBeTypeOf("string");
  });

  it("keeps at least one factor while replacing the password factor", async () => {
    const h = createHarness();
    await h.settle();
    // A password-only vault: the single factor is a password.
    const created = ok(
      await h.call("wallet.createMnemonic", {
        words: 12,
        factor: { kind: "password", password: utf8ToBytes("only factor password") },
      }),
    );
    const draft = strField(created, "draft");
    const words = new TextDecoder().decode(bytesField(created, "words")).split(" ");
    const quiz = intList(created, "quiz");
    const answers = quiz.map((i) => utf8ToBytes(must(words[i])));
    const confirmed = ok(await h.call("wallet.confirmMnemonic", { draft, answers }));
    const session = strField(confirmed, "session");
    expect(lastStatus(h).factors).toHaveLength(1);

    // Replacing the only factor in one commit never drops below one.
    ok(
      await h.call(
        "vault.addFactor",
        {
          verify: { kind: "password", password: utf8ToBytes("only factor password") },
          factor: { kind: "password", password: utf8ToBytes("rotated factor pass") },
        },
        session,
      ),
    );
    expect(lastStatus(h).factors).toHaveLength(1);
  });

  it("resets to uninitialized even when the store watch never fires", async () => {
    // A host store that suppresses change notices for the kernel's own commits (as the real
    // Web/Node stores do): the commit path itself must reload the image and drop the session.
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    expect(ok(await h.call("vault.reset", null, session))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
    expect(lockReasons(h.events)).toContain("user");
  });

  it("locks via the injected idle timer with no request in flight", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    h.advance(61_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("idle");
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
      "locked",
    );
  });

  it("no idle policy: stays unlocked past any idle window and expires at max session", async () => {
    const h = createHarness({ noIdle: true, maxSessionMs: 3_600_000 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    // Past every web/node idle window — still unlocked, requests still succeed.
    h.advance(1_800_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("unlocked");
    expect(ok(await h.call("status", null, session))).toBeDefined();
    // The session ends only at the max-session deadline.
    h.advance(1_800_001);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("expired");
  });

  it("a respawned kernel starts locked and rejects a stale session id", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    // Lock is host-side now: the worker is terminated and a fresh kernel respawns on the store.
    const h2 = respawn(h);
    await h2.settle();
    expect(lastStatus(h2).vault.status).toBe("locked");
    expect(errCode(await h2.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
      "locked",
    );
    // A stale session id is rejected even after re-unlock.
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    expect(strField(unlocked, "session")).not.toBe(session);
  });

  it("resets back to uninitialized", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    expect(ok(await h.call("vault.reset", null, session))).toBeNull();
    await h.settle();
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({ status: "uninitialized" });
  });

  it("deletes a wallet and its derived keys atomically", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const derivedPk = await deriveKey(h, session, walletId, 0);
    ok(await h.call("nostr.deriveKey", { walletId, index: 5 }, session));
    // A key derived from another wallet is not this wallet's: it survives the deletion.
    const other = ok(
      await h.call(
        "wallet.importMnemonic",
        { mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic) },
        session,
      ),
    );
    const walletId2 = strField(field(other, "wallet"), "walletId");
    const derived = strField(
      ok(await h.call("nostr.deriveKey", { walletId: walletId2, index: 0 }, session)),
      "publicKey",
    );
    expect(lastStatus(h).nostr.keys).toHaveLength(3);
    expect(
      ok(
        await h.call(
          "wallet.delete",
          {
            verify: {
              kind: "passkey",
              credentialId: CREDENTIAL_ID,
              prf: new Uint8Array(PRF_VAULT),
            },
            walletId,
          },
          session,
        ),
      ),
    ).toBeNull();
    const status = lastStatus(h);
    expect(status.wallets.map((w) => w.walletId)).toStrictEqual([walletId2]);
    expect(status.nostr.keys.map((k) => k.publicKey)).toStrictEqual([derived]);
    // The delete committed atomically: no derived row survived, no signer is left in the pool.
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 6 }, session))).toBe(
      "not-found",
    );
    expect(
      errCode(
        await h.call(
          "nostr.signEvent",
          {
            publicKey: derivedPk,
            event: { kind: 1, created_at: 1, tags: [], content: "x" },
          },
          session,
        ),
      ),
    ).toBe("not-found");
  });
});

describe("session expiry and rate limiting", () => {
  it("locks on idle expiry", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    h.advance(61_000);
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
      "locked",
    );
    expect(lockReasons(h.events)).toContain("idle");
  });

  it("locks on max-session expiry", async () => {
    const h = createHarness({ maxSessionMs: 3_600_000, idleMs: 10 * 3_600_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    h.advance(3_700_000);
    // status does not need a session; the vault field now reports locked.
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({ status: "locked" });
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
      "locked",
    );
    expect(lockReasons(h.events)).toContain("expired");
  });

  it("a backward wall-clock jump never extends the session", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    // The wall clock jumps an hour backwards: session deadlines ride the monotonic clock.
    h.advanceWall(-3_600_000);
    h.advance(61_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("idle");
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
      "locked",
    );
  });

  it("a forward wall-clock jump never shortens the session", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    h.advanceWall(10 * 3_600_000); // the wall clock leaps forward ten hours
    // Elapsed time is what counts: still unlocked a second later, idle-locked at 60 s.
    h.advance(1000);
    expect("ok" in (await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(true);
    h.advance(61_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("idle");
  });
});

it("a re-unlock on the same vault keeps the session and its max-session deadline", async () => {
  const h = createHarness({ maxSessionMs: 120_000, idleMs: 3_600_000 });
  await h.settle();
  const { session, walletId } = await createPasskeyWallet(h); // session A, opened at t=0
  h.advance(60_000); // halfway through the absolute lifetime

  const again = ok(await h.call("vault.unlock", { factor: passkeyFactor() }));
  expect(strField(again, "session")).toBe(session); // no rotation — same session A
  const publicKey = await deriveKey(h, session, walletId); // requests on A still work
  expect(publicKey).toMatch(/^[0-9a-f]{64}$/);

  // The second unlock did not reset the clock: the max measured from the first still applies.
  h.advance(61_000); // t=121s > 120s max
  expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 0 }, session))).toBe("locked");
  expect(lockReasons(h.events)).toContain("expired");
});

it("a re-unlock with a wrong factor fails and leaves the live session valid", async () => {
  const h = createHarness();
  await h.settle();
  const { session, walletId } = await createPasskeyWallet(h);
  const bad = {
    kind: "passkey" as const,
    credentialId: CREDENTIAL_ID,
    prf: new Uint8Array(PRF_VAULT.length).fill(0xff),
  };
  expect(errCode(await h.call("vault.unlock", { factor: bad }))).not.toBe("");
  // Session A is untouched — a sessioned request still succeeds.
  const publicKey = await deriveKey(h, session, walletId);
  expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
  expect(lastStatus(h).vault.status).toBe("unlocked");
});

describe("presence activity", () => {
  it("signing traffic does not extend the idle deadline", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const publicKey = await deriveKey(h, session, walletId);
    h.advance(59_000);
    // A sign at t=59 s succeeds — but it is not presence, so the 60 s deadline stands.
    expect(
      "ok" in
        (await h.call(
          "nostr.signEvent",
          { publicKey, event: { kind: 1, created_at: 1, tags: [], content: "x" } },
          session,
        )),
    ).toBe(true);
    h.advance(2000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("idle");
  });

  it("session.touch extends the idle deadline", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    h.advance(59_000);
    expect(ok(await h.call("session.touch", null, session))).toBeNull();
    // The deadline moved to t=119 s: still unlocked at 110 s, idle-locked after.
    h.advance(51_000);
    expect("ok" in (await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(true);
    h.advance(10_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("idle");
  });

  it("a presence-bearing request extends the idle deadline", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    h.advance(59_000);
    // exportMnemonic carries presence: the idle deadline moves to t=119 s.
    ok(
      await h.call(
        "wallet.exportMnemonic",
        {
          verify: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
          walletId,
        },
        session,
      ),
    );
    h.advance(51_000);
    // A session-only (non-presence) request still works past the original deadline.
    expect("ok" in (await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(true);
    h.advance(10_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
  });

  it("a failed request does not extend the idle deadline", async () => {
    const h = createHarness({ idleMs: 60_000 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    h.advance(59_000);
    // The miss arrives at t=59 s — an error is not activity.
    expect(
      errCode(
        await h.call(
          "nostr.signEvent",
          {
            publicKey: "00".repeat(32),
            event: { kind: 1, created_at: 1, tags: [], content: "x" },
          },
          session,
        ),
      ),
    ).toBe("not-found");
    h.advance(2000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("idle");
  });

  it("request activity mode refreshes on every successful request", async () => {
    const h = createHarness({ idleMs: 60_000, activity: "request" });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const publicKey = await deriveKey(h, session, walletId);
    h.advance(59_000);
    expect(
      "ok" in
        (await h.call(
          "nostr.signEvent",
          { publicKey, event: { kind: 1, created_at: 1, tags: [], content: "x" } },
          session,
        )),
    ).toBe(true);
    // The successful sign moved the deadline to t=119 s — and this probe (also a successful
    // request, as every request counts in request mode) moved it again to t=170 s.
    h.advance(51_000);
    ok(await h.call("nostr.removeKey", { publicKey }, session)); // every request counts
    h.advance(61_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
  });

  it("max session expires regardless of touches", async () => {
    const h = createHarness({ idleMs: 10 * 3_600_000, maxSessionMs: 3_600_000 });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    h.advance(1_800_000);
    expect(ok(await h.call("session.touch", null, session))).toBeNull();
    h.advance(1_500_000);
    expect(ok(await h.call("session.touch", null, session))).toBeNull();
    // t=3.3 h on a 1 h cap: touches keep idle away but the maximum still lands.
    h.advance(400_000);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("locked");
    expect(lockReasons(h.events)).toContain("expired");
    expect(errCode(await h.call("session.touch", null, session))).toBe("locked");
  });
});

describe("password rate limiting", () => {
  /** A vault whose only factor is a password, created on `h`. */
  async function createPasswordVault(h: Harness): Promise<void> {
    ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
  }

  const badPassword = async (h: Harness) =>
    h.call("vault.unlock", {
      factor: { kind: "password", password: utf8ToBytes("a wrong password") },
    });

  it("limits wrong passwords: 30s, 60s, 300s — on a non-echoing store", async () => {
    // The real Web/Node stores never echo a worker's own commits (issue #91).
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasswordVault(h);
    const h2 = respawn(h, nonEchoing);
    await h2.settle();

    // Failures 1-4: wrong-password, no rate limit yet.
    for (let i = 0; i < 4; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- unlock attempts are sequential by design
      expect(errCode(await badPassword(h2))).toBe("wrong-password");
    }
    // The 5th failure arms the 30 s backoff.
    expect(errCode(await badPassword(h2))).toBe("wrong-password");
    const t = h2.wallNow();
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
    // The 6th attempt is rate-limited with the armed deadline — never counted: retries cannot
    // push the horizon forward.
    const limited = await badPassword(h2);
    expect(errCode(limited)).toBe("rate-limited");
    expect(errPayload(limited).retryAt).toBe(t + 30_000);
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
    // The next real failure lands the 6th increment and arms the 60 s tier.
    h2.advanceWall(61_000);
    expect(errCode(await badPassword(h2))).toBe("wrong-password");
    const limited2 = await badPassword(h2);
    expect(errCode(limited2)).toBe("rate-limited");
    expect(errPayload(limited2).retryAt).toBe(t + 61_000 + 60_000);
    // The 7th real failure arms the 300 s tier.
    h2.advanceWall(61_000);
    expect(errCode(await badPassword(h2))).toBe("wrong-password");
    const limited3 = await badPassword(h2);
    expect(errCode(limited3)).toBe("rate-limited");
    expect(errPayload(limited3).retryAt).toBe(t + 122_000 + 300_000);
    // Success resets the counter — a fresh failure starts at 1.
    h2.advanceWall(301_000);
    const unlocked = await h2.call("vault.unlock", {
      factor: { kind: "password", password: new Uint8Array(PASSWORD) },
    });
    expect("ok" in unlocked).toBe(true);
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(0);
    const h3 = respawn(h, nonEchoing);
    await h3.settle();
    expect(errCode(await badPassword(h3))).toBe("wrong-password");
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(1);
  });

  it("pipelined attempts never lose an increment", async () => {
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasswordVault(h);
    const h2 = respawn(h, nonEchoing);
    await h2.settle();
    const results = await Promise.all(Array.from({ length: 6 }, async () => badPassword(h2)));
    const codes = results.map(errCode);
    expect(codes.filter((c) => c === "wrong-password")).toHaveLength(5);
    expect(codes.filter((c) => c === "rate-limited")).toHaveLength(1);
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
  });

  it("retries during backoff move neither the counter nor the deadline", async () => {
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasswordVault(h);
    const h2 = respawn(h, nonEchoing);
    await h2.settle();
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- unlock attempts are sequential by design
      expect(errCode(await badPassword(h2))).toBe("wrong-password");
    }
    const t = h2.wallNow();
    // Every further attempt while armed reports the same deadline and leaves the counter at 5.
    for (let i = 0; i < 4; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- unlock attempts are sequential by design
      const limited = await badPassword(h2);
      expect(errCode(limited)).toBe("rate-limited");
      expect(errPayload(limited).retryAt).toBe(t + 30_000);
    }
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
  });

  it("re-verification shares the persisted counters and arms the same backoff", async () => {
    // F-005: verifyFactor rate-limits with the exact same persisted counters as vault.unlock.
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasswordVault(h);
    const h2 = respawn(h, nonEchoing);
    await h2.settle();
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const session = strField(unlocked, "session");
    const badVerify = async () =>
      h2.call(
        "vault.addFactor",
        {
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
          verify: { kind: "password", password: utf8ToBytes("a wrong password") },
        },
        session,
      );
    // Misses 1-5 are honest wrong-password errors — each one lands its increment.
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- attempts are sequential by design
      expect(errCode(await badVerify())).toBe("wrong-password");
    }
    const t = h2.wallNow();
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
    // The next re-verification is rate-limited with the armed deadline — never counted.
    const limited = await badVerify();
    expect(errCode(limited)).toBe("rate-limited");
    expect(errPayload(limited).retryAt).toBe(t + 30_000);
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
    // The shared counter gates the unlock path too: a fresh locked kernel sees the same horizon.
    const h3 = respawn(h, nonEchoing);
    await h3.settle();
    const limitedUnlock = await badPassword(h3);
    expect(errCode(limitedUnlock)).toBe("rate-limited");
    expect(errPayload(limitedUnlock).retryAt).toBe(t + 30_000);
  });

  it("unlock failures count toward re-verification backoff", async () => {
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasswordVault(h);
    const h2 = respawn(h, nonEchoing);
    await h2.settle();
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const session = strField(unlocked, "session");
    // unlock attempts while the session is live still land their increments on the shared counter.
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- attempts are sequential by design
      expect(errCode(await badPassword(h2))).toBe("wrong-password");
    }
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
    const limited = await h2.call(
      "vault.addFactor",
      {
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        verify: { kind: "password", password: utf8ToBytes("a wrong password") },
      },
      session,
    );
    expect(errCode(limited)).toBe("rate-limited");
  });

  it("a successful re-verification resets the counter", async () => {
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasswordVault(h);
    const h2 = respawn(h, nonEchoing);
    await h2.settle();
    const unlocked = ok(
      await h2.call("vault.unlock", {
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const session = strField(unlocked, "session");
    const badVerify = async () =>
      h2.call(
        "vault.addFactor",
        {
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
          verify: { kind: "password", password: utf8ToBytes("a wrong password") },
        },
        session,
      );
    for (let i = 0; i < 4; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- attempts are sequential by design
      expect(errCode(await badVerify())).toBe("wrong-password");
    }
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(4);
    // A correct verify clears the counter — the next miss starts at 1, not 5.
    const right = await h2.call(
      "vault.addFactor",
      {
        factor: { kind: "password", password: utf8ToBytes("another password ok") },
        verify: { kind: "password", password: new Uint8Array(PASSWORD) },
      },
      session,
    );
    expect("ok" in right).toBe(true);
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(0);
    expect(errCode(await badVerify())).toBe("wrong-password");
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(1);
  });

  it("two kernels sharing one store never lose an increment", async () => {
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasswordVault(h);
    const a = respawn(h, nonEchoing);
    const b = respawn(h, nonEchoing);
    await a.settle();
    await b.settle();
    const results = await Promise.all([
      ...Array.from({ length: 5 }, async () => badPassword(a)),
      ...Array.from({ length: 5 }, async () => badPassword(b)),
    ]);
    // The wrong-password/rate-limited split depends on interleaving — whichever attempts reload
    // before the counter crosses 5 see an unarmed backoff. What must hold: every attempt either
    // failed honestly or was limited, every honest miss landed its increment (never lost), and
    // enough attempts ran far enough to arm the backoff.
    const codes = results.map(errCode);
    for (const code of codes) {
      expect(["wrong-password", "rate-limited"]).toContain(code);
    }
    const counted = codes.filter((c) => c === "wrong-password").length;
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(counted);
    expect(counted).toBeGreaterThanOrEqual(5);
  });

  it("a password attempt on a passkey-only vault is invalid-input and never counted", async () => {
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    await createPasskeyWallet(h);
    const h2 = respawn(h, nonEchoing);
    await h2.settle();
    expect(errCode(await badPassword(h2))).toBe("invalid-input");
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(0);
  });

  it("a passkey unlock is never gated by password backoff", async () => {
    const h = createHarness({ wrapStore: nonEchoing });
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    ok(
      await h.call(
        "vault.addFactor",
        {
          verify: passkeyFactor(),
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        },
        session,
      ),
    );
    const h2 = respawn(h, nonEchoing);
    await h2.settle();
    // Arm the backoff fully — the sixth attempt is rejected without counting.
    for (let i = 0; i < 6; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential attempts
      await badPassword(h2);
    }
    await expect(storedFailedAttempts(h.anchor)).resolves.toBe(5);
    // The passkey path does not consult the password counters at all.
    const unlocked = await h2.call("vault.unlock", { factor: passkeyFactor() });
    expect("ok" in unlocked).toBe(true);
  });
});

describe("integrity", () => {
  it("an open healthy vault resets only with its live session", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    // A sessionless call on an open, healthy vault is refused before anything is erased.
    expect(errCode(await h.call("vault.reset", null))).toBe("locked");
    expect(lastStatus(h).vault.status).toBe("unlocked");
    // The live session resets.
    expect(ok(await h.call("vault.reset", null, session))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
  });

  it("a locked vault resets without a session", async () => {
    const h = createHarness();
    await h.settle();
    await createPasskeyWallet(h);
    const h2 = createHarness({ store: h.store, anchor: h.anchor });
    await h2.settle();
    expect(lastStatus(h2).vault.status).toBe("locked");
    expect(ok(await h2.call("vault.reset"))).toBeNull();
    expect(lastStatus(h2).vault.status).toBe("uninitialized");
  });

  it("a record that fails authentication at unlock corrupts the vault; reset recovers", async () => {
    const h = createHarness();
    await h.settle();
    await createPasskeyWallet(h);
    const image = await h.store.load();
    const record = must(image.records.find((r) => r.kind === "entropy"));
    const header = JSON.parse(record.header) as Record<string, unknown>;
    header["backup"] = "none";
    await h.store.commit([
      { op: "put-record", record: { ...record, header: JSON.stringify(header) } },
    ]);
    await h.settle();
    const res = await h.call("vault.unlock", {
      factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
    });
    expect(errCode(res)).toBe("integrity");
    // The DEK opened but a record failed authentication: the vault is corrupted.
    expect(lastStatus(h).vault.status).toBe("corrupted");
    // While corrupted only status and vault.reset are served — no session opens.
    expect(errCode(await h.call("nostr.deriveKey", { walletId: "0f".repeat(8), index: 7 }))).toBe(
      "integrity",
    );
    expect(
      errCode(
        await h.call("vault.unlock", {
          factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
        }),
      ),
    ).toBe("integrity");
    expect(ok(await h.call("vault.reset"))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
    // The corruption latch is gone: an empty vault fails unlock honestly.
    expect(
      errCode(
        await h.call("vault.unlock", {
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        }),
      ),
    ).toBe("invalid-input");
  });

  it("rejects swapped sealed blobs between records", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    await deriveKey(h, session, walletId); // a second sealed record to swap with
    const image = await h.store.load();
    const [rawA, rawB] = image.records;
    const a = must(rawA);
    const b = must(rawB);
    await h.store.commit([
      { op: "put-record", record: { ...a, sealed: b.sealed } },
      { op: "put-record", record: { ...b, sealed: a.sealed } },
    ]);
    await h.settle();
    const res = await h.call("vault.unlock", {
      factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
    });
    expect(errCode(res)).toBe("integrity");
    expect(lastStatus(h).vault.status).toBe("corrupted");
  });

  it("a public header that fails to parse corrupts the vault on reload", async () => {
    const h = createHarness();
    await h.settle();
    await createPasskeyWallet(h);
    const image = await h.store.load();
    const factor = must(image.factors[0]);
    await h.store.commit([{ op: "put-factor", factor: { ...factor, header: "not json" } }]);
    await h.settle();
    // The watch reload parsed the tampered header: corrupted, and the bad row is omitted.
    const status = lastStatus(h);
    expect(status.vault.status).toBe("corrupted");
    expect(status.factors).toHaveLength(0);
    expect(status.wallets).toHaveLength(1);
    expect(
      errCode(
        await h.call("vault.unlock", {
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        }),
      ),
    ).toBe("integrity");
    expect(ok(await h.call("vault.reset"))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
  });

  it("a stored record of an unknown kind is unsupported — the vault locks and stays untouched", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const before = await h.store.load();
    // Simulate a vault written by a newer build: a record kind this kernel does not own.
    await h.store.commit([
      {
        op: "put-record",
        record: {
          kind: "spark-key",
          id: "00".repeat(32),
          header: JSON.stringify({ publicKey: "00".repeat(32), createdAt: 0 }),
          sealed: new Uint8Array(48),
        },
      },
    ]);
    await h.settle();
    const status = lastStatus(h);
    expect(status.vault).toStrictEqual({ status: "unsupported", reason: "newer" });
    // The unlocked session is invalidated immediately, not at the next timeout.
    expect(lockReasons(h.events)).toContain("invalidated");
    // Everything except status and vault.reset fails closed — the store bytes stay as written.
    expect(
      errCode(
        await h.call("vault.unlock", {
          factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
        }),
      ),
    ).toBe("unsupported");
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
      "unsupported",
    );
    const untouched = await h.store.load();
    expect(untouched.records).toHaveLength(before.records.length + 1);
    expect(untouched.records.some((r) => r.kind === "spark-key")).toBe(true);
    expect(ok(await h.call("vault.reset"))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
  });

  it("a racing establish fails with conflict and writes nothing", async () => {
    const h = createHarness();
    await h.settle();
    const created = ok(
      await h.call("wallet.createMnemonic", {
        words: 12,
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const draft = strField(created, "draft");
    const quiz = intList(created, "quiz");
    const words = new TextDecoder().decode(bytesField(created, "words")).split(" ");

    // Another tab establishes a vault first.
    const other = createHarness({ store: h.store, seed: 2, anchor: h.anchor });
    await other.settle();
    ok(
      await other.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"),
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const established = await h.store.load();
    await h.settle();

    const answers = quiz.map((p) => utf8ToBytes(words[p]!));
    const res = await h.call("wallet.confirmMnemonic", { draft, answers });
    expect(errCode(res)).toBe("conflict");
    await expect(h.store.load()).resolves.toStrictEqual(established);
  });

  it("rejects malformed requests with integrity and keeps serving", async () => {
    const h = createHarness();
    await h.settle();
    expect(errCode(await h.call("no.such.method"))).toBe("integrity");
    expect(errCode(await h.call("status", { unexpected: 1 }))).toBe("integrity");
    expect(field(ok(await h.call("status")), "protocol")).toBe(3);
  });

  it("a store that fails to load reports corrupted until reset re-establishes it", async () => {
    let broken = true;
    const h = createHarness({
      wrapStore: (store) => ({ ...store, load: failingLoad(store, () => broken) }),
    });
    await h.settle();
    // The enclave did not crash: the startup status event still went out, reporting corrupted.
    expect(h.events.some((e) => e.event === "status")).toBe(true);
    expect(lastStatus(h).vault.status).toBe("corrupted");
    // Every request except status and vault.reset answers integrity.
    expect(
      errCode(
        await h.call("vault.unlock", {
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        }),
      ),
    ).toBe("integrity");
    expect(errCode(await h.call("nostr.deriveKey", { walletId: "0f".repeat(8), index: 7 }))).toBe(
      "integrity",
    );
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({ status: "corrupted" });
    // vault.reset is the recovery path: its commit re-establishes the store.
    broken = false;
    await h.call("vault.reset");
    expect(lastStatus(h).vault.status).toBe("uninitialized");
    // Back to honest behavior: unlock on an empty vault is invalid-input, not integrity.
    expect(
      errCode(
        await h.call("vault.unlock", {
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        }),
      ),
    ).toBe("invalid-input");
  });
});

describe("vault health", () => {
  it("a meta format this build cannot read is unsupported and stays untouched", async () => {
    const h = createHarness();
    await h.settle();
    // A newer build initialized this vault.
    await h.store.commit([{ op: "init", meta: metaOf({ format: VAULT_FORMAT + 1 }) }]);
    await h.settle();
    expect(lastStatus(h).vault).toStrictEqual({ status: "unsupported", reason: "newer" });
    expect(errCode(await h.call("vault.unlock", { factor: passkeyFactor() }))).toBe("unsupported");
    // Nothing is rewritten and reset still recovers.
    const metaAfter = await storedMeta(h.store);
    expect(metaAfter.format).toBe(VAULT_FORMAT + 1);
    expect(ok(await h.call("vault.reset"))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
  });

  it("an older build's meta format is unsupported with reason older — reset then restore", async () => {
    const h = createHarness();
    await h.settle();
    // A pre-1.0 build initialized this vault; this build has no reader for it.
    await h.store.commit([{ op: "init", meta: metaOf({ format: VAULT_FORMAT - 1 }) }]);
    await h.settle();
    expect(lastStatus(h).vault).toStrictEqual({ status: "unsupported", reason: "older" });
    expect(errCode(await h.call("vault.unlock", { factor: passkeyFactor() }))).toBe("unsupported");
    const metaAfter = await storedMeta(h.store);
    expect(metaAfter.format).toBe(VAULT_FORMAT - 1);
    // The only exit is the explicit reset: the vault is cleared, never silently wiped.
    expect(ok(await h.call("vault.reset"))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
  });

  it("a factor kind this build does not know is unsupported", async () => {
    const h = createHarness();
    await h.settle();
    await h.store.commit([
      { op: "init", meta: metaOf() },
      {
        op: "put-factor",
        factor: {
          kind: "u2f-key",
          id: "cc".repeat(16),
          header: "{}",
          sealed: new Uint8Array(48),
        },
      },
    ]);
    await h.settle();
    expect(lastStatus(h).vault).toStrictEqual({ status: "unsupported", reason: "newer" });
    expect(errCode(await h.call("vault.unlock", { factor: passkeyFactor() }))).toBe("unsupported");
  });

  it("a password factor with unknown KDF parameters is unsupported", async () => {
    const h = createHarness();
    await h.settle();
    await h.store.commit([
      { op: "init", meta: metaOf() },
      {
        op: "put-factor",
        factor: {
          kind: "password",
          id: "dd".repeat(16),
          header: JSON.stringify({
            salt: "AAAAAAAAAAAAAAAAAAAAAA",
            iterations: 1_000_000,
            publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            createdAt: 0,
          }),
          sealed: new Uint8Array(48),
        },
      },
    ]);
    await h.settle();
    expect(lastStatus(h).vault).toStrictEqual({ status: "unsupported", reason: "newer" });
    const stored = await h.store.load();
    expect(stored.factors[0]?.kind).toBe("password");
  });

  it("a malformed header of a known kind while unlocked is corrupted and locks at once", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    await h.store.commit([
      {
        op: "put-factor",
        factor: {
          kind: "password",
          id: "ee".repeat(16),
          header: "not json",
          sealed: new Uint8Array(48),
        },
      },
    ]);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("corrupted");
    // The unlocked session is invalidated immediately — DEK and drafts are wiped.
    expect(lockReasons(h.events)).toContain("invalidated");
    expect(errCode(await h.call("nostr.deriveKey", { walletId, index: 9 }, session))).toBe(
      "integrity",
    );
    expect(ok(await h.call("vault.reset"))).toBeNull();
    expect(lastStatus(h).vault.status).toBe("uninitialized");
  });

  it("a transient load failure is unavailable — retried, never latched", async () => {
    const broken = { current: false };
    const h = createHarness({ wrapStore: (store) => flakyLoad(store, broken) });
    await h.settle();
    await createPasskeyWallet(h);
    await h.settle(); // flush the create commit's own echo-reload before arming the failure
    // An external (precondition-only, content-neutral) commit triggers a reload whose load fails.
    broken.current = true;
    await h.store.commit([{ op: "expect-revision", revision: 1 }]);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("unavailable");
    broken.current = false;
    // The next request retries the load once, recovers, and runs honestly.
    const unlocked = await h.call("vault.unlock", { factor: passkeyFactor() });
    expect("ok" in unlocked).toBe(true);
    expect(lastStatus(h).vault.status).toBe("unlocked");
  });

  it("a store that fails to load at startup is unavailable, not corrupted", async () => {
    const broken = { current: true };
    const h = createHarness({ wrapStore: (store) => flakyLoad(store, broken) });
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("unavailable");
    expect(errCode(await h.call("nostr.deriveKey", { walletId: "0f".repeat(8), index: 7 }))).toBe(
      "unavailable",
    );
    broken.current = false;
    // The next request's reload restores health without any reset.
    const created = await h.call("wallet.createMnemonic", {
      words: 12,
      factor: { kind: "password", password: new Uint8Array(PASSWORD) },
    });
    expect("ok" in created).toBe(true);
  });

  it("a generic commit failure surfaces as unavailable", async () => {
    const broken = { current: true };
    const h = createHarness({ wrapStore: (store) => flakyCommit(store, broken) });
    await h.settle();
    const res = await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
      factor: { kind: "password", password: new Uint8Array(PASSWORD) },
    });
    expect(errCode(res)).toBe("unavailable");
    expect(lastStatus(h).vault.status).toBe("unavailable");
    broken.current = false;
    const retry = await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
      factor: { kind: "password", password: new Uint8Array(PASSWORD) },
    });
    expect("ok" in retry).toBe(true);
  });
});

describe("concurrent writers on one store", () => {
  /** A vault with password + passkey factors; both kernels hold unlocked sessions. */
  async function twoKernels(): Promise<{
    shared: ReturnType<typeof createMemoryStore>;
    a: Harness;
    b: Harness;
    sessionA: string;
    sessionB: string;
    walletId: string;
    passwordFactorId: string;
    passkeyFactorId: string;
  }> {
    const shared = createMemoryStore();
    const anchor = createMemoryAnchor();
    const a = createHarness({ store: shared, anchor });
    await a.settle();
    const created = ok(
      await a.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    const sessionA = strField(created, "session");
    const walletId = strField(field(created, "wallet"), "walletId");
    ok(
      await a.call(
        "vault.addFactor",
        {
          verify: { kind: "password", password: new Uint8Array(PASSWORD) },
          factor: passkeyFactor(),
        },
        sessionA,
      ),
    );
    const { factors } = lastStatus(a);
    const passwordFactorId = factorId(factors.find((f) => f.kind === "password"));
    const passkeyFactorId = factorId(factors.find((f) => f.kind === "passkey"));
    const b = createHarness({ store: shared, anchor });
    await b.settle();
    const unlockB = ok(
      await b.call("vault.unlock", {
        factor: { kind: "password", password: new Uint8Array(PASSWORD) },
      }),
    );
    return {
      shared,
      a,
      b,
      sessionA,
      sessionB: strField(unlockB, "session"),
      walletId,
      passwordFactorId,
      passkeyFactorId,
    };
  }

  it("concurrent removeFactor commits conflict — exactly one wins, one factor remains", async () => {
    const { shared, a, b, sessionA, sessionB, passwordFactorId, passkeyFactorId } =
      await twoKernels();
    // Each call needs its own verify object: the kernel wipes the password bytes it consumes.
    const [ra, rb] = await Promise.all([
      a.call(
        "vault.removeFactor",
        { verify: { kind: "password", password: new Uint8Array(PASSWORD) }, id: passkeyFactorId },
        sessionA,
      ),
      b.call(
        "vault.removeFactor",
        { verify: { kind: "password", password: new Uint8Array(PASSWORD) }, id: passwordFactorId },
        sessionB,
      ),
    ]);
    const codes = [ra, rb].map(codeOf);
    expect(codes.filter((c) => c === "ok")).toHaveLength(1);
    expect(codes.filter((c) => c === "conflict")).toHaveLength(1);
    const image = await shared.load();
    expect(image.factors.length).toBeGreaterThanOrEqual(1);
  });

  it("concurrent password addFactor commits conflict — one password factor remains", async () => {
    const { shared, a, b, sessionA, sessionB } = await twoKernels();
    const [ra, rb] = await Promise.all([
      a.call(
        "vault.addFactor",
        {
          verify: { kind: "password", password: new Uint8Array(PASSWORD) },
          factor: { kind: "password", password: utf8ToBytes("new password alpha") },
        },
        sessionA,
      ),
      b.call(
        "vault.addFactor",
        {
          verify: { kind: "password", password: new Uint8Array(PASSWORD) },
          factor: { kind: "password", password: utf8ToBytes("new password bravo") },
        },
        sessionB,
      ),
    ]);
    const codes = [ra, rb].map(codeOf);
    expect(codes.filter((c) => c === "ok")).toHaveLength(1);
    expect(codes.filter((c) => c === "conflict")).toHaveLength(1);
    const image = await shared.load();
    expect(image.factors.filter((f) => f.kind === "password")).toHaveLength(1);
  });
});

/** A password Factor for `vault.unlock` / verify fields — fresh bytes every call. */
function passwordFactor(password: Uint8Array | string = PASSWORD): {
  kind: "password";
  password: Uint8Array;
} {
  return {
    kind: "password",
    password: typeof password === "string" ? utf8ToBytes(password) : new Uint8Array(password),
  };
}

/** `sealed` with the byte at `offset` flipped — raw-store tampering helper. */
function tamperSealed(sealed: Uint8Array, offset: number): Uint8Array {
  const copy = new Uint8Array(sealed);
  copy[offset] = (copy[offset] ?? 0) ^ 1;
  return copy;
}

/** The record row matching `(kind, id)`, if any. */
function recordOf(image: VaultImage, kind: string, id: string): StoredRecord | undefined {
  return image.records.find((r) => r.kind === kind && r.id === id);
}

/** Unwraps the vault DEK from the (single) password factor row using the kernel's own functions. */
async function dekFromStore(store: RecordStore, password: Uint8Array): Promise<Secret> {
  const image = await store.load();
  const factor = must(image.factors.find((f) => f.kind === "password"));
  const { salt } = parsePasswordFactorHeader(factor.header);
  const kek = await passwordKek(password, base64urlnopad.decode(salt), subtlePbkdf2);
  try {
    return unwrapDek(kek, factor);
  } finally {
    wipe(kek); // unwrapDek does not consume it
  }
}

/**
 * A structurally valid factor row bound to an attacker's own DEK — publicKey unwraps fine but the
 * binding tag does not match this vault's DEK.
 */
function plantedFactor(): StoredFactor {
  const attackerDek = Secret.take(hexToBytes("42".repeat(32)));
  const attackerKek = hexToBytes("17".repeat(32));
  const publicKey = factorPublicKey(attackerKek);
  const id = "99".repeat(16);
  const header = encodeHeader({
    credentialId: "3q2-78r-",
    publicKey: base64urlnopad.encode(publicKey),
    createdAt: 0,
  });
  const sealed = wrapDek(attackerDek, publicKey, { kind: "passkey", id, header }, (length) =>
    new Uint8Array(length).fill(7),
  );
  attackerDek.wipe();
  return { kind: "passkey", id, header, sealed };
}

describe("public-key factor wrapping and DEK rotation", () => {
  it("a tampered factor binding corrupts the vault at unlock", async () => {
    const shared = createMemoryStore();
    const anchor = createMemoryAnchor();
    const setup = createHarness({ store: shared, anchor });
    await setup.settle();
    await createPasskeyWallet(setup);

    // Flip a byte inside the binding tag (offset 33..65) of the stored factor row.
    const image = await shared.load();
    const factor = must(image.factors[0]);
    const sealed = tamperSealed(factor.sealed, 40);
    await shared.commit([{ op: "put-factor", factor: { ...factor, sealed } }]);

    const h = createHarness({ store: shared, anchor });
    await h.settle();
    expect(errCode(await h.call("vault.unlock", { factor: passkeyFactor() }))).toBe("integrity");
    expect(lastStatus(h).vault.status).toBe("corrupted");
    // Nothing unlocked: no session, no keys.
    await expect(h.call("status")).resolves.toBeDefined();
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({ status: "corrupted" });
  });

  it("a planted factor row corrupts a locked vault — the real password cannot unlock", async () => {
    const shared = createMemoryStore();
    const anchor = createMemoryAnchor();
    const setup = createHarness({ store: shared, anchor });
    await setup.settle();
    ok(
      await setup.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: passwordFactor(),
      }),
    );
    await shared.commit([{ op: "put-factor", factor: plantedFactor() }]);

    const h = createHarness({ store: shared, anchor });
    await h.settle();
    // The password still unwraps the real factor; reconciliation then proves the planted row's
    // binding does not match this vault's DEK.
    expect(errCode(await h.call("vault.unlock", { factor: passwordFactor() }))).toBe("integrity");
    expect(lastStatus(h).vault.status).toBe("corrupted");
    expect(lockReasons(h.events)).toContain("invalidated");
  });

  it("a planted factor row invalidates an unlocked session at once", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const publicKey = await deriveKey(h, session, walletId);
    await h.store.commit([{ op: "put-factor", factor: plantedFactor() }]);
    await h.settle();
    expect(lastStatus(h).vault.status).toBe("corrupted");
    expect(lockReasons(h.events)).toContain("invalidated");
    expect(
      errCode(
        await h.call(
          "nostr.signEvent",
          { publicKey, event: { kind: 1, created_at: 1, tags: [], content: "x" } },
          session,
        ),
      ),
    ).toBe("integrity");
  });

  it("changing the password rotates: new keyId, every record resealed, old DEK stale", async () => {
    const h = createHarness();
    await h.settle();
    const created = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: passwordFactor(),
      }),
    );
    const session = strField(created, "session");
    const walletId = strField(field(created, "wallet"), "walletId");
    await deriveKey(h, session, walletId);
    const before = await h.store.load();
    const oldDek = await dekFromStore(h.store, new Uint8Array(PASSWORD));
    try {
      ok(
        await h.call(
          "vault.addFactor",
          { verify: passwordFactor(), factor: passwordFactor("rotated horse battery") },
          session,
        ),
      );
      const after = await h.store.load();
      expect(must(after.meta).keyId).not.toBe(must(before.meta).keyId);
      // Every record re-sealed under the new DEK: same public headers, different bytes.
      expect(after.records).toHaveLength(before.records.length);
      for (const record of after.records) {
        const old = must(recordOf(before, record.kind, record.id));
        expect(record.header).toBe(old.header);
        expect(bytesToHex(record.sealed)).not.toBe(bytesToHex(old.sealed));
        expect(kernelError(() => openRecord(oldDek, record))).toBe("integrity");
      }
    } finally {
      oldDek.wipe();
    }
    // Old password is just wrong now; the new one unlocks.
    const h2 = respawn(h);
    await h2.settle();
    expect(errCode(await h2.call("vault.unlock", { factor: passwordFactor() }))).toBe(
      "wrong-password",
    );
    expect(
      "ok" in (await h2.call("vault.unlock", { factor: passwordFactor("rotated horse battery") })),
    ).toBe(true);
  });

  it("adding a passkey keeps the keyId and both factors unlock", async () => {
    const h = createHarness();
    await h.settle();
    const created = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: passwordFactor(),
      }),
    );
    const session = strField(created, "session");
    const keyIdBefore = await storedMeta(h.store);
    ok(
      await h.call(
        "vault.addFactor",
        { verify: passwordFactor(), factor: passkeyFactor() },
        session,
      ),
    );
    await expect(storedMeta(h.store)).resolves.toMatchObject({ keyId: keyIdBefore.keyId });
    expect(lastStatus(h).factors).toHaveLength(2);

    const h2 = respawn(h);
    await h2.settle();
    expect("ok" in (await h2.call("vault.unlock", { factor: passkeyFactor() }))).toBe(true);
    const h3 = respawn(h);
    await h3.settle();
    expect("ok" in (await h3.call("vault.unlock", { factor: passwordFactor() }))).toBe(true);
  });

  it("removing a passkey rotates; the password still unlocks and the passkey fails", async () => {
    const h = createHarness();
    await h.settle();
    const created = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: passwordFactor(),
      }),
    );
    const session = strField(created, "session");
    const added = ok(
      await h.call(
        "vault.addFactor",
        { verify: passwordFactor(), factor: passkeyFactor() },
        session,
      ),
    );
    const passkeyId = strField(added, "id");
    const keyIdBefore = await storedMeta(h.store);
    ok(await h.call("vault.removeFactor", { verify: passwordFactor(), id: passkeyId }, session));
    const keyIdAfter = await storedMeta(h.store);
    expect(keyIdAfter.keyId).not.toBe(keyIdBefore.keyId);
    expect(lastStatus(h).factors).toHaveLength(1);

    const h2 = respawn(h);
    await h2.settle();
    expect("ok" in (await h2.call("vault.unlock", { factor: passwordFactor() }))).toBe(true);
    const h3 = respawn(h);
    await h3.settle();
    // The removed factor's credential matches nothing: a plain miss, not corruption.
    expect(errCode(await h3.call("vault.unlock", { factor: passkeyFactor() }))).toBe(
      "wrong-passkey",
    );
  });
});

describe("live-state reconciliation across kernels", () => {
  /**
   * A password vault on a shared store with A and B both unlocked (echoing watch: a commit on the
   * raw store notifies both kernels).
   */
  async function pair(): Promise<{
    shared: ReturnType<typeof createMemoryStore>;
    a: Harness;
    b: Harness;
    sessionA: string;
    sessionB: string;
    walletId: string;
  }> {
    const shared = createMemoryStore();
    const anchor = createMemoryAnchor();
    const a = createHarness({ store: shared, anchor });
    await a.settle();
    const created = ok(
      await a.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(nip06.vectors[0]!.mnemonic),
        factor: passwordFactor(),
      }),
    );
    const sessionA = strField(created, "session");
    const walletId = strField(field(created, "wallet"), "walletId");
    const b = createHarness({ store: shared, anchor });
    await b.settle();
    const unlockB = ok(await b.call("vault.unlock", { factor: passwordFactor() }));
    return { shared, a, b, sessionA, walletId, sessionB: strField(unlockB, "session") };
  }

  const signWith = async (h: Harness, session: string, publicKey: string) =>
    h.call(
      "nostr.signEvent",
      { publicKey, event: { kind: 1, created_at: 1, tags: [], content: "x" } },
      session,
    );

  it("a key deleted in A is forgotten in B at once; a key imported in A signs in B", async () => {
    const { b, sessionB, sessionA, a, walletId } = await pair();
    const pk = strField(
      ok(await a.call("nostr.deriveKey", { walletId, index: 9 }, sessionA)),
      "publicKey",
    );
    await b.settle();
    // B never ran the import: reconciliation claimed the new record — it can sign immediately.
    expect("ok" in (await signWith(b, sessionB, pk))).toBe(true);

    ok(await a.call("nostr.removeKey", { publicKey: pk }, sessionA));
    await b.settle();
    // The record is gone from the image; B's live signer is forgotten — not-found, not stale sign.
    expect(errCode(await signWith(b, sessionB, pk))).toBe("not-found");
  });

  it("a key derived in A is live in B without a re-unlock", async () => {
    const { a, b, sessionA, sessionB, walletId } = await pair();
    const derived = ok(await a.call("nostr.deriveKey", { walletId, index: 11 }, sessionA));
    const pk = strField(derived, "publicKey");
    await b.settle();
    const signed = ok(await signWith(b, sessionB, pk));
    expect(strField(signed, "pubkey")).toBe(pk);
  });

  it("deleting a wallet in A removes its derived keys from B's live state", async () => {
    const { a, b, sessionA, sessionB, walletId } = await pair();
    const pk = await deriveKey(a, sessionA, walletId);
    await b.settle();
    expect("ok" in (await signWith(b, sessionB, pk))).toBe(true);
    ok(await a.call("wallet.delete", { verify: passwordFactor(), walletId }, sessionA));
    await b.settle();
    expect(errCode(await signWith(b, sessionB, pk))).toBe("not-found");
    expect(lastStatus(b).nostr.keys).toHaveLength(0);
  });

  it("rotation in A invalidates B; A stays unlocked and signs", async () => {
    const { a, b, sessionA, sessionB, walletId } = await pair();
    const pk = await deriveKey(a, sessionA, walletId);
    await b.settle();
    const passkeyId = strField(
      ok(
        await a.call(
          "vault.addFactor",
          { verify: passwordFactor(), factor: passkeyFactor() },
          sessionA,
        ),
      ),
      "id",
    );
    // Removing the passkey rotates the vault DEK + keyId under one guarded commit.
    ok(await a.call("vault.removeFactor", { verify: passwordFactor(), id: passkeyId }, sessionA));
    await b.settle();
    // B's session DEK no longer matches the vault keyId: invalidated on the reload.
    expect(lockReasons(b.events)).toContain("invalidated");
    expect(lastStatus(b).vault.status).toBe("locked");
    expect(errCode(await signWith(b, sessionB, pk))).toBe("locked");
    // A rotated its own session: still unlocked and signing under the new DEK.
    expect(lastStatus(a).vault.status).toBe("unlocked");
    const signed = ok(await signWith(a, sessionA, pk));
    expect(verifyEvent(signed as Event)).toBe(true);
    // The password factor row was re-wrapped under the new DEK: B re-unlocks with it.
    expect("ok" in (await b.call("vault.unlock", { factor: passwordFactor() }))).toBe(true);
  });

  it("tampered record bytes corrupt B on the next watch reload", async () => {
    const { shared, a, b, sessionA, sessionB, walletId } = await pair();
    const pk = await deriveKey(a, sessionA, walletId);
    await b.settle();
    const image = await shared.load();
    const record = must(recordOf(image, "nostr-key", pk));
    const sealed = tamperSealed(record.sealed, record.sealed.length - 1);
    await shared.commit([{ op: "put-record", record: { ...record, sealed } }]);
    await b.settle();
    expect(lastStatus(b).vault.status).toBe("corrupted");
    expect(lockReasons(b.events)).toContain("invalidated");
    expect(errCode(await signWith(b, sessionB, pk))).toBe("integrity");
  });

  it("a rotation racing a record write yields exactly one conflict and a consistent store", async () => {
    const { shared, a, b, sessionA, sessionB, walletId } = await pair();
    const added = ok(
      await a.call(
        "vault.addFactor",
        { verify: passwordFactor(), factor: passkeyFactor() },
        sessionA,
      ),
    );
    const passkeyId = strField(added, "id");
    const [rotated, write] = await Promise.all([
      a.call("vault.removeFactor", { verify: passwordFactor(), id: passkeyId }, sessionA),
      b.call("nostr.deriveKey", { walletId, index: 7 }, sessionB),
    ]);
    const codes = [rotated, write].map(codeOf).toSorted();
    expect(codes).toStrictEqual(["conflict", "ok"]);
    // Whichever won, every stored record authenticates under the vault's final DEK.
    const dek = await dekFromStore(shared, new Uint8Array(PASSWORD));
    try {
      const image = await shared.load();
      for (const record of image.records) {
        openRecord(dek, record);
      }
    } finally {
      dek.wipe();
    }
  });
});

describe("request structure", () => {
  it("answers a request carrying an unknown envelope field with integrity", async () => {
    const h = createHarness();
    await h.settle();
    const res = await h.sendRaw({ v: 3, id: 1, method: "status", params: null, extra: 1 });
    expect(errCode(res)).toBe("integrity");
  });

  it("answers a request on a non-plain object with integrity", async () => {
    const h = createHarness();
    await h.settle();
    // A prototype the structured-clone boundary can never produce. The refusal answers under the
    // unattributed id because the envelope is refused before its id field is trusted, so sendRaw
    // would wait on id 7 forever — inspect the posted replies instead.
    const raw = Object.assign(Object.create({ sentinel: true }), {
      v: 3,
      id: 7,
      method: "status",
      params: null,
    });
    void h.sendRaw(raw);
    await h.settle();
    expect(h.posted.at(-1)).toMatchObject({ id: 0, err: { code: "integrity" } });
  });

  /**
   * A depth-64 binary DAG: every level shares one live array as both children, so a validator that
   * re-walks shared references would take 2^64 steps on a value under 1 KiB on the wire.
   */
  const dag = (depth: number): unknown[] => {
    let node: unknown[] = [];
    for (let i = 0; i < depth; i++) {
      node = [node, node];
    }
    return node;
  };

  it("sizes a shared-reference params DAG without expanding it and keeps serving", async () => {
    const h = createHarness();
    await h.settle();
    // Tiny on the wire, 2^64 nodes as a tree: over the size cap, found without walking it all.
    const res = await h.sendRaw({ v: 3, id: 9, method: "status", params: dag(64) });
    expect(errCode(res)).toBe("invalid-input");
    expect("ok" in (await h.call("status"))).toBe(true);
  });

  it("answers cyclic params with integrity", async () => {
    const h = createHarness();
    await h.settle();
    const params: unknown[] = [];
    params.push({ inner: [params] });
    expect(errCode(await h.sendRaw({ v: 3, id: 10, method: "status", params }))).toBe("integrity");
  });

  it("answers methods named after Object.prototype members with integrity", async () => {
    const h = createHarness();
    await h.settle();
    for (const method of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- raw requests are sequential
      expect(errCode(await h.sendRaw({ v: 3, id: 1, method, params: null }))).toBe("integrity");
    }
  });
});

describe("request size cap", () => {
  it("answers an over-cap raw request with invalid-input", async () => {
    const h = createHarness();
    await h.settle();
    const res = await h.sendRaw({
      v: 3,
      id: 7,
      method: "nostr.signEvent",
      params: {
        publicKey: "ab".repeat(32),
        event: { kind: 1, created_at: 1, tags: [], content: "x".repeat(400_000) },
      },
    });
    expect(errCode(res)).toBe("invalid-input");
  });

  it("serves a request just under the cap", async () => {
    const h = createHarness();
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const publicKey = await deriveKey(h, session, walletId);
    const res = await h.sendRaw({
      v: 3,
      id: 8,
      method: "nostr.signEvent",
      session,
      params: {
        publicKey,
        event: { kind: 1, created_at: 1, tags: [], content: "x".repeat(262_144) },
      },
    });
    expect("ok" in res).toBe(true);
  });
});

describe("nostr backup state", () => {
  const verify = passkeyFactor;

  async function exportKey(
    h: ReturnType<typeof createHarness>,
    session: string,
    publicKey: string,
    format: ProtocolValue,
  ): Promise<ProtocolValue> {
    return ok(await h.call("nostr.exportKey", { verify: verify(), publicKey, format }, session));
  }

  // Four sequential scrypt exports — under coverage instrumentation they can exceed 5 s.
  it(
    "exports ncryptsec with key security byte 0x02 for derived keys",
    { timeout: 30_000 },
    async () => {
      const h = createHarness();
      await h.settle();
      const { session, walletId } = await createPasskeyWallet(h);

      const derived = await deriveKey(h, session, walletId);
      const second = strField(
        ok(await h.call("nostr.deriveKey", { walletId, index: 7 }, session)),
        "publicKey",
      );
      for (const publicKey of [derived, second]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential exports through one kernel
        const encoded = await exportKey(h, session, publicKey, {
          kind: "ncryptsec",
          password: utf8ToBytes("export-pw"),
        });
        expect(exportedKsb(encoded)).toBe(0x02);
      }
    },
  );
});

describe("backend routing (WD-054)", () => {
  it("keys/sign/ECDH/verify route through platform.backends.nostr", async () => {
    const counts = { publicKey: 0, sign: 0, verifySerialized: 0, ecdhX: 0 };
    const counting = new Proxy(nobleBackend, {
      get: (target, key: keyof NostrBackend) => {
        const fn = target[key];
        return (...args: unknown[]) => {
          counts[key] += 1;
          return (fn as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const h = createHarness({
      backends: {
        nostr: counting,
        spark: async () => {
          await Promise.resolve();
          throw new Error("no spark");
        },
      },
    });
    await h.settle();
    const { session, walletId } = await createPasskeyWallet(h);
    const derived = ok(await h.call("nostr.deriveKey", { walletId, index: 13 }, session));
    const publicKey = strField(derived, "publicKey");
    expect(counts.publicKey).toBeGreaterThan(0);
    ok(
      await h.call(
        "nostr.signEvent",
        { publicKey, event: { kind: 1, created_at: 1, tags: [], content: "x" } },
        session,
      ),
    );
    expect(counts.sign).toBeGreaterThan(0);
    ok(await h.call("nostr.nip44Encrypt", { publicKey, peer: publicKey, text: "hi" }, session));
    expect(counts.ecdhX).toBeGreaterThan(0);
    const wrapSigner = new KeysSigner(Keys.generate());
    const rumor = createRumor(await wrapSigner.getPublicKey(), {
      kind: 1,
      created_at: 1,
      tags: [],
      content: "dm",
    });
    const wrap = await nip59Wrap(wrapSigner, publicKey, rumor);
    await h.call("nostr.unwrapGiftWraps", { publicKey, events: [wrap] }, session);
    expect(counts.verifySerialized).toBeGreaterThan(0);
    wrapSigner.dispose();
  });
});

describe("rotation and the session", () => {
  /**
   * WebCrypto PBKDF2 that runs `onNth` right after the `nth` 600 000-iteration derivation once
   * armed — while the command awaiting it is still suspended, exactly where a timer can fire.
   */
  function tripwire(onNth: () => void, nth: number): { pbkdf2: Pbkdf2; arm: () => void } {
    let armed = false;
    let derived = 0;
    return {
      pbkdf2: async (hash, password, salt, iterations, length) => {
        const out = await subtlePbkdf2(hash, password, salt, iterations, length);
        if (armed && iterations === 600_000) {
          derived += 1;
          if (derived === nth) {
            onNth();
          }
        }
        return out;
      },
      arm: () => {
        armed = true;
      },
    };
  }

  it("a session that ends during a password change fails it as locked, never corrupted", async () => {
    const ref: { h?: Harness } = {};
    // The second derivation after arming is the new password's KEK, inside the rotation.
    const { pbkdf2, arm } = tripwire(() => ref.h?.advance(5 * 60_000 + 1), 2);
    const h = createHarness({ idleMs: 5 * 60_000, pbkdf2 });
    ref.h = h;
    await h.settle();
    const oldPassword = () => ({
      kind: "password" as const,
      password: utf8ToBytes("old-password-123"),
    });
    const session = strField(
      ok(
        await h.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"),
          factor: oldPassword(),
        }),
      ),
      "session",
    );
    arm();
    const changed = await h.call(
      "vault.addFactor",
      {
        verify: oldPassword(),
        factor: { kind: "password", password: utf8ToBytes("new-password-456") },
      },
      session,
    );
    expect(errCode(changed)).toBe("locked");
    expect(lastStatus(h).vault.status).toBe("locked");
    // Nothing landed: the old password still opens the vault, in this kernel and a fresh one.
    ok(await h.call("vault.unlock", { factor: oldPassword() }));
    const fresh = createHarness({ store: h.store, anchor: h.anchor });
    await fresh.settle();
    ok(await fresh.call("vault.unlock", { factor: oldPassword() }));
  });
});

describe("create/import failure hygiene", () => {
  const zeroed = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

  /** Platform.random that records the live buffers it hands out, so a wiped DEK is visible. */
  const trackingRandom = (seed: number) => {
    const { random } = seededRandom(seed);
    const buffers: Uint8Array[] = [];
    return {
      buffers,
      random: (length: number): Uint8Array => {
        const b = random(length);
        buffers.push(b);
        return b;
      },
    };
  };

  it("wipes the DEK minted for a fresh vault when the mnemonic is invalid", async () => {
    const tracked = trackingRandom(300);
    const h = createHarness({ random: tracked.random });
    await h.settle();
    const before = tracked.buffers.length;
    const mnemonic = utf8ToBytes("not a valid mnemonic at all");
    expect(
      errCode(
        await h.call("wallet.importMnemonic", {
          mnemonic,
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        }),
      ),
    ).toBe("invalid-input");
    expect(zeroed(mnemonic)).toBe(true);
    // The gate's `random(32)` draw is the only 32-byte buffer the failed call produced.
    const drawn32 = tracked.buffers.slice(before).filter((b) => b.length === 32);
    expect(drawn32.length).toBeGreaterThanOrEqual(1);
    for (const buffer of drawn32) {
      expect(zeroed(buffer)).toBe(true);
    }
  });

  it("wipes the mnemonic and passphrase when the gate fails on an initialized vault", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const mnemonic = utf8ToBytes(nip06.vectors[0]!.mnemonic);
    const passphrase = utf8ToBytes("a passphrase");
    expect(
      errCode(
        await h.call(
          "wallet.importMnemonic",
          {
            mnemonic,
            passphrase,
            factor: { kind: "password", password: new Uint8Array(PASSWORD) },
          },
          session,
        ),
      ),
    ).toBe("invalid-input");
    expect(zeroed(mnemonic)).toBe(true);
    expect(zeroed(passphrase)).toBe(true);
  });

  it("wipes the wire prfWallet when a host createWithPasskey fails the gate", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const prfWallet = new Uint8Array(PRF_WALLET);
    expect(
      errCode(
        await h.call(
          "wallet.createWithPasskey",
          {
            ceremony: "host",
            credentialId: CREDENTIAL_ID,
            prfWallet,
            synced: true,
            factor: {
              kind: "passkey",
              credentialId: CREDENTIAL_ID,
              prf: new Uint8Array(PRF_VAULT),
            },
          },
          session,
        ),
      ),
    ).toBe("invalid-input");
    expect(zeroed(prfWallet)).toBe(true);
  });

  it("keeps the session DEK alive when an import fails on an initialized vault", async () => {
    const h = createHarness();
    await h.settle();
    const mnemonic = utf8ToBytes(nip06.vectors[0]!.mnemonic);
    const session = strField(
      ok(
        await h.call("wallet.importMnemonic", {
          mnemonic: new Uint8Array(mnemonic),
          factor: { kind: "password", password: new Uint8Array(PASSWORD) },
        }),
      ),
      "session",
    );
    // The same wallet again fails already-exists — after the gate bound the live session DEK.
    expect(
      errCode(
        await h.call("wallet.importMnemonic", { mnemonic: new Uint8Array(mnemonic) }, session),
      ),
    ).toBe("already-exists");
    ok(await h.call("keys.list", null, session));
  });
});
