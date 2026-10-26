/**
 * The Web EngineStore: one IndexedDB database, one `records` object store, values encrypted per
 * record with XChaCha20-Poly1305. Key = the injected 32-byte data key; nonce = 24 random bytes
 * stored as nonce‖ciphertext; AAD = UTF-8 `<collection>\0<key>` — moving a record to another key or
 * collection fails the MAC, same as a tampered payload. `close()` drops the connection, wipes the
 * module-held key copy and latches every call to `closed`.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { EngineStoreError } from "../errors.ts";
import { checkName } from "../store/guard.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";

export type Random = (length: number) => Uint8Array;

export type IndexedDbEngineStoreOptions = {
  readonly name: string;
  readonly dataKey: Uint8Array;
  readonly random: Random;
};

const STORE = "records";

const id = (collection: string, recordKey: string): string => `${collection}\u0000${recordKey}`;
const aad = (collection: string, recordKey: string): Uint8Array =>
  new TextEncoder().encode(`${collection}\u0000${recordKey}`);

async function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => {
      resolve(req.result);
    });
    req.addEventListener("error", () => {
      reject(new Error("indexeddb request failed", { cause: req.error }));
    });
  });
}

async function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => {
      resolve();
    });
    tx.addEventListener("error", () => {
      reject(new Error("indexeddb transaction failed", { cause: tx.error }));
    });
    tx.addEventListener("abort", () => {
      reject(new Error("indexeddb transaction aborted", { cause: tx.error }));
    });
  });
}

export function openIndexedDbEngineStore(
  options: IndexedDbEngineStoreOptions,
): Promise<EngineStore> {
  const key = new Uint8Array(options.dataKey);
  return new Promise<EngineStore>((resolveOpen, rejectOpen) => {
    const open = indexedDB.open(options.name, 1);
    open.addEventListener("upgradeneeded", () => {
      open.result.createObjectStore(STORE);
    });
    open.addEventListener("success", () => {
      resolveOpen(makeStore(open.result, key, options.random));
    });
    open.addEventListener("error", () => {
      key.fill(0);
      rejectOpen(new Error("indexeddb open failed", { cause: open.error }));
    });
  });
}

function makeStore(db: IDBDatabase, key: Uint8Array, random: Random): EngineStore {
  let closed = false;

  const guard = (): IDBDatabase => {
    if (closed) {
      throw new EngineStoreError("closed", "engine store is closed");
    }
    return db;
  };

  const seal = (collection: string, recordKey: string, bytes: Uint8Array): Uint8Array => {
    const nonce = random(24);
    const ciphertext = xchacha20poly1305(key, nonce, aad(collection, recordKey)).encrypt(bytes);
    const record = new Uint8Array(24 + ciphertext.length);
    record.set(nonce, 0);
    record.set(ciphertext, 24);
    return record;
  };

  const open = (collection: string, recordKey: string, record: Uint8Array): Uint8Array => {
    if (record.length < 24) {
      throw new EngineStoreError("integrity", "engine record too short");
    }
    try {
      return xchacha20poly1305(key, record.slice(0, 24), aad(collection, recordKey)).decrypt(
        record.slice(24),
      );
    } catch {
      throw new EngineStoreError("integrity", "engine record failed integrity");
    }
  };

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
