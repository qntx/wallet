import { checkName } from "../store/guard.ts";
import type { PublicStore } from "../store/port.ts";
import { done, request } from "./requests.ts";

export type IndexedDbPublicStoreOptions = { readonly name: string };

const STORE = "records";

/** An unencrypted IndexedDB PublicStore: one database, one `records` object store. */
export async function openIndexedDbPublicStore(
  options: IndexedDbPublicStoreOptions,
): Promise<PublicStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(options.name, 1);
    open.addEventListener("upgradeneeded", () => {
      open.result.createObjectStore(STORE);
    });
    open.addEventListener("success", () => {
      resolve(open.result);
    });
    open.addEventListener("error", () => {
      reject(new Error("indexeddb open failed", { cause: open.error }));
    });
  });
  return {
    get: async (key) => {
      checkName("key", key);
      const tx = db.transaction(STORE, "readonly");
      // oxlint-disable-next-line typescript/no-unsafe-argument -- IDB get() is any-typed by spec
      const value = await request<Uint8Array | undefined>(tx.objectStore(STORE).get(key));
      return value === undefined ? undefined : new Uint8Array(value);
    },
    put: async (key, bytes) => {
      checkName("key", key);
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(new Uint8Array(bytes), key);
      await done(tx);
    },
  };
}
