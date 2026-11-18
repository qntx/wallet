/**
 * The Web EngineStore: one IndexedDB database, one `records` object store, values encrypted per
 * record with XChaCha20-Poly1305. Key = the injected 32-byte data key; nonce = 24 random bytes
 * stored as nonce‖ciphertext; AAD = UTF-8 `<collection>\0<key>` — moving a record to another key or
 * collection fails the MAC, same as a tampered payload, and a record that fails its MAC reads
 * exactly like a missing one. A reserved `check` row sealed under a fixed AAD proves the data key
 * at open: a database keyed differently is rebuilt empty. `close()` drops the connection, wipes the
 * module-held key copy and latches every call to `closed`.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { EngineStoreError } from "../errors.ts";
import { checkName } from "../store/guard.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";
import { done, request } from "./requests.ts";

export { openIndexedDbPublicStore } from "./public-store.ts";
export type { IndexedDbPublicStoreOptions } from "./public-store.ts";

export type Random = (length: number) => Uint8Array;

export type IndexedDbEngineStoreOptions = {
  readonly name: string;
  readonly dataKey: Uint8Array;
  readonly random: Random;
};

const STORE = "records";
const CHECK_KEY = "check";
const CHECK_AAD = new TextEncoder().encode("qntx-engine-store-check");

const id = (collection: string, recordKey: string): string => `${collection}\u0000${recordKey}`;
const aad = (collection: string, recordKey: string): Uint8Array =>
  new TextEncoder().encode(`${collection}\u0000${recordKey}`);

const sealRecord = (
  key: Uint8Array,
  random: Random,
  aadBytes: Uint8Array,
  bytes: Uint8Array,
): Uint8Array => {
  const nonce = random(24);
  const ciphertext = xchacha20poly1305(key, nonce, aadBytes).encrypt(bytes);
  const record = new Uint8Array(24 + ciphertext.length);
  record.set(nonce, 0);
  record.set(ciphertext, 24);
  return record;
};

/** The plaintext, or `undefined` when the record fails authentication — it reads as deleted. */
const openRecord = (
  key: Uint8Array,
  aadBytes: Uint8Array,
  record: Uint8Array,
): Uint8Array | undefined => {
  if (record.length < 24) {
    return undefined;
  }
  try {
    return xchacha20poly1305(key, record.slice(0, 24), aadBytes).decrypt(record.slice(24));
  } catch {
    return undefined;
  }
};

export async function openIndexedDbEngineStore(
  options: IndexedDbEngineStoreOptions,
): Promise<EngineStore> {
  const key = new Uint8Array(options.dataKey);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(options.name, 1);
    open.addEventListener("upgradeneeded", () => {
      open.result.createObjectStore(STORE);
    });
    open.addEventListener("success", () => {
      resolve(open.result);
    });
    open.addEventListener("error", () => {
      key.fill(0);
      reject(new Error("indexeddb open failed", { cause: open.error }));
    });
  });
  try {
    await checkStoreKey(db, key, options.random);
  } catch (error) {
    db.close();
    key.fill(0);
    throw error;
  }
  return makeStore(db, key, options.random);
}

/** One read-write transaction before the store is handed out: `check` must open under this key. */
async function checkStoreKey(db: IDBDatabase, key: Uint8Array, random: Random): Promise<void> {
  const tx = db.transaction(STORE, "readwrite");
  const records = tx.objectStore(STORE);
  // oxlint-disable-next-line typescript/no-unsafe-argument -- IDB get() is any-typed by spec
  const existing = await request<Uint8Array | undefined>(records.get(CHECK_KEY));
  if (existing === undefined || openRecord(key, CHECK_AAD, existing) === undefined) {
    // Rows sealed under another data key (a reset or recreated vault) are unreadable by
    // construction — the store is rebuilt empty rather than served back as dead rows.
    records.clear();
    records.put(sealRecord(key, random, CHECK_AAD, new Uint8Array(0)), CHECK_KEY);
  }
  await done(tx);
}

function makeStore(db: IDBDatabase, key: Uint8Array, random: Random): EngineStore {
  let closed = false;

  const guard = (): IDBDatabase => {
    if (closed) {
      throw new EngineStoreError("closed", "engine store is closed");
    }
    return db;
  };

  const seal = (collection: string, recordKey: string, bytes: Uint8Array): Uint8Array =>
    sealRecord(key, random, aad(collection, recordKey), bytes);

  const open = (
    collection: string,
    recordKey: string,
    record: Uint8Array,
  ): Uint8Array | undefined => openRecord(key, aad(collection, recordKey), record);

  const make = (name: string): EngineCollection => ({
    get: async (recordKey) => {
      const database = guard();
      checkName("key", recordKey);
      const tx = database.transaction(STORE, "readonly");
      const raw = tx.objectStore(STORE).get(id(name, recordKey));
      // oxlint-disable-next-line typescript/no-unsafe-argument -- IDB get() is any-typed by spec
      const record = await request<Uint8Array | undefined>(raw);
      return record === undefined ? undefined : open(name, recordKey, record);
    },
    put: async (recordKey, bytes) => {
      const database = guard();
      checkName("key", recordKey);
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(seal(name, recordKey, bytes), id(name, recordKey));
      await done(tx);
    },
    delete: async (recordKey) => {
      const database = guard();
      checkName("key", recordKey);
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id(name, recordKey));
      await done(tx);
    },
    list: async () => {
      const database = guard();
      const tx = database.transaction(STORE, "readonly");
      const all = tx.objectStore(STORE).getAllKeys();
      const keys = await request<IDBValidKey[]>(all);
      const prefix = `${name}\u0000`;
      return keys
        .filter((k): k is string => typeof k === "string" && k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  });

  return {
    collection: (name) => {
      checkName("collection", name);
      return make(name);
    },
    close: async () => {
      closed = true;
      db.close();
      key.fill(0);
      await Promise.resolve();
    },
  };
}
