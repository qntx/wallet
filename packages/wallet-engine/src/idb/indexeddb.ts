/**
 * The Web EngineStore: one IndexedDB database (format 2), two object stores, values encrypted per
 * record with XChaCha20-Poly1305. The injected data key derives two subkeys at open via
 * HKDF-SHA256: `sealKey` encrypts every row, `idKey` names them — a record id is the lowercase hex
 * of `hmac(sha256, idKey, utf8(collection) ‖ 0x00 ‖ utf8(key))`, so nothing readable on disk
 * reveals collection names or record keys.
 *
 * `records` maps id → nonce‖ciphertext(value) under AAD `record\0${id}`; `index` maps the same id →
 * nonce‖ciphertext(utf8(`${collection}\0${key}`)) under AAD `index\0${id}` and backs `list`. Moving
 * a row to another id fails its MAC, same as a tampered payload, and a record that fails its MAC
 * reads exactly like a missing one. A reserved `check` row in `index` sealed under a fixed AAD
 * proves the data key at open: a database keyed differently is rebuilt empty. This still leaks the
 * record count, the value sizes and write timing. `close()` drops the connection, wipes both
 * subkeys and latches every call to `closed`.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

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

const RECORDS = "records";
const INDEX = "index";
const CHECK_KEY = "check";
const CHECK_AAD = new TextEncoder().encode("qntx-engine-store-check");

const utf8 = new TextEncoder();
const utf8decode = new TextDecoder();

const recordId = (idKey: Uint8Array, collection: string, recordKey: string): string => {
  const c = utf8.encode(collection);
  const k = utf8.encode(recordKey);
  const msg = new Uint8Array(c.length + 1 + k.length);
  msg.set(c, 0);
  msg.set(k, c.length + 1);
  const hex = bytesToHex(hmac(sha256, idKey, msg));
  msg.fill(0);
  return hex;
};

const aad = (kind: "record" | "index", id: string): Uint8Array => utf8.encode(`${kind}\u0000${id}`);

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
  const sealKey = hkdf(sha256, key, undefined, utf8.encode("qntx/engine-store/seal"), 32);
  const idKey = hkdf(sha256, key, undefined, utf8.encode("qntx/engine-store/id"), 32);
  key.fill(0);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(options.name, 2);
    open.addEventListener("upgradeneeded", () => {
      const { result } = open;
      for (const storeName of result.objectStoreNames) {
        result.deleteObjectStore(storeName);
      }
      result.createObjectStore(RECORDS);
      result.createObjectStore(INDEX);
    });
    open.addEventListener("success", () => {
      resolve(open.result);
    });
    open.addEventListener("error", () => {
      sealKey.fill(0);
      idKey.fill(0);
      reject(new Error("indexeddb open failed", { cause: open.error }));
    });
  });
  try {
    await checkStoreKey(db, sealKey, options.random);
  } catch (error) {
    db.close();
    sealKey.fill(0);
    idKey.fill(0);
    throw error;
  }
  return makeStore(db, sealKey, idKey, options.random);
}

/** One read-write transaction before the store is handed out: `check` must open under this key. */
async function checkStoreKey(db: IDBDatabase, key: Uint8Array, random: Random): Promise<void> {
  const tx = db.transaction([RECORDS, INDEX], "readwrite");
  const index = tx.objectStore(INDEX);
  // oxlint-disable-next-line typescript/no-unsafe-argument -- IDB get() is any-typed by spec
  const existing = await request<Uint8Array | undefined>(index.get(CHECK_KEY));
  if (existing === undefined || openRecord(key, CHECK_AAD, existing) === undefined) {
    // Rows sealed under another data key (a reset or recreated vault) are unreadable by
    // construction — the store is rebuilt empty rather than served back as dead rows.
    tx.objectStore(RECORDS).clear();
    index.clear();
    index.put(sealRecord(key, random, CHECK_AAD, new Uint8Array(0)), CHECK_KEY);
  }
  await done(tx);
}

function makeStore(
  db: IDBDatabase,
  sealKey: Uint8Array,
  idKey: Uint8Array,
  random: Random,
): EngineStore {
  let closed = false;

  const guard = (): IDBDatabase => {
    if (closed) {
      throw new EngineStoreError("closed", "engine store is closed");
    }
    return db;
  };

  const make = (name: string): EngineCollection => ({
    get: async (recordKey) => {
      const database = guard();
      checkName("key", recordKey);
      const recId = recordId(idKey, name, recordKey);
      const tx = database.transaction(RECORDS, "readonly");
      const raw = tx.objectStore(RECORDS).get(recId);
      // oxlint-disable-next-line typescript/no-unsafe-argument -- IDB get() is any-typed by spec
      const record = await request<Uint8Array | undefined>(raw);
      return record === undefined ? undefined : openRecord(sealKey, aad("record", recId), record);
    },
    put: async (recordKey, bytes) => {
      const database = guard();
      checkName("key", recordKey);
      const recId = recordId(idKey, name, recordKey);
      const header = utf8.encode(`${name}\u0000${recordKey}`);
      const tx = database.transaction([RECORDS, INDEX], "readwrite");
      tx.objectStore(RECORDS).put(sealRecord(sealKey, random, aad("record", recId), bytes), recId);
      tx.objectStore(INDEX).put(sealRecord(sealKey, random, aad("index", recId), header), recId);
      await done(tx);
    },
    delete: async (recordKey) => {
      const database = guard();
      checkName("key", recordKey);
      const recId = recordId(idKey, name, recordKey);
      const tx = database.transaction([RECORDS, INDEX], "readwrite");
      tx.objectStore(RECORDS).delete(recId);
      tx.objectStore(INDEX).delete(recId);
      await done(tx);
    },
    list: async () => {
      const database = guard();
      const tx = database.transaction(INDEX, "readonly");
      const index = tx.objectStore(INDEX);
      // Both requests issue in this task so the transaction stays alive; getAll returns values
      // in the same key order as getAllKeys.
      const keys = request<IDBValidKey[]>(index.getAllKeys());
      const values = request<unknown[]>(index.getAll());
      const [allKeys, allValues] = await Promise.all([keys, values]);
      const out: string[] = [];
      for (const [i, k] of allKeys.entries()) {
        if (k === CHECK_KEY || typeof k !== "string") {
          continue;
        }
        const value = allValues[i];
        if (!(value instanceof Uint8Array)) {
          continue;
        }
        const plain = openRecord(sealKey, aad("index", k), value);
        if (plain === undefined) {
          continue;
        }
        const text = utf8decode.decode(plain);
        const nul = text.indexOf("\u0000");
        if (nul !== -1 && text.slice(0, nul) === name) {
          out.push(text.slice(nul + 1));
        }
      }
      return out;
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
      sealKey.fill(0);
      idKey.fill(0);
      await Promise.resolve();
    },
  };
}
