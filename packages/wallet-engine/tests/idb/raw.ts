/** Raw fake-indexeddb access for tamper tests — not a test file, so control flow is allowed. */

import { done, request } from "../../src/idb/requests.ts";

export type RawStore = "records" | "index";

async function withStore<T>(
  store: RawStore,
  mode: IDBTransactionMode,
  fn: (os: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("t");
    r.addEventListener("success", () => {
      resolve(r.result);
    });
    r.addEventListener("error", () => {
      reject(new Error("open failed", { cause: r.error }));
    });
  });
  try {
    return await fn(db.transaction(store, mode).objectStore(store));
  } finally {
    db.close();
  }
}

export async function rawGet(store: RawStore, storeKey: string): Promise<Uint8Array> {
  return withStore(store, "readonly", async (os) => {
    const value = await request<unknown>(os.get(storeKey));
    if (!(value instanceof Uint8Array)) {
      throw new TypeError("unexpected record shape");
    }
    return new Uint8Array(value);
  });
}

export async function rawPut(store: RawStore, storeKey: string, value: Uint8Array): Promise<void> {
  await withStore(store, "readwrite", async (os) => {
    os.put(value, storeKey);
    await done(os.transaction);
  });
}

export async function rawKeys(store: RawStore): Promise<ReadonlyArray<string>> {
  return withStore(store, "readonly", async (os) => {
    const keys = await request<IDBValidKey[]>(os.getAllKeys());
    return keys.filter((k): k is string => typeof k === "string");
  });
}

export async function rawDelete(store: RawStore, storeKey: string): Promise<void> {
  await withStore(store, "readwrite", async (os) => {
    os.delete(storeKey);
    await done(os.transaction);
  });
}

export async function rawEntries(
  store: RawStore,
): Promise<ReadonlyArray<{ readonly key: string; readonly value: Uint8Array }>> {
  return withStore(store, "readonly", async (os) => {
    const [keys, values] = await Promise.all([
      request<IDBValidKey[]>(os.getAllKeys()),
      request<unknown[]>(os.getAll()),
    ]);
    const utf8 = new TextEncoder();
    return keys.map((k, i) => {
      const v = values[i];
      return {
        key: typeof k === "string" ? k : JSON.stringify(k),
        value: v instanceof Uint8Array ? new Uint8Array(v) : utf8.encode(JSON.stringify(v)),
      };
    });
  });
}

export function corruptByte(bytes: Uint8Array, index: number): void {
  bytes[index] = (bytes[index] ?? 0) + 1;
}

const utf8 = new TextEncoder();
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Independent oracle for a record id: WebCrypto HKDF derives the id subkey from `dataKey`,
 * WebCrypto HMAC names the record — nothing from the implementation under test.
 */
export async function oracleId(
  dataKey: Uint8Array,
  collection: string,
  recordKey: string,
): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", new Uint8Array(dataKey), "HKDF", false, [
    "deriveBits",
  ]);
  const idKey = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: utf8.encode("qntx/engine-store/id"),
    },
    ikm,
    256,
  );
  const signer = await crypto.subtle.importKey(
    "raw",
    idKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const c = utf8.encode(collection);
  const k = utf8.encode(recordKey);
  const msg = new Uint8Array(c.length + 1 + k.length);
  msg.set(c, 0);
  msg.set(k, c.length + 1);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", signer, msg)));
}
