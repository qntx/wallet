import { EngineStoreError } from "../errors.ts";
import type { EngineCollection, EngineStore } from "./port.ts";

/** In-memory EngineStore: the Node/test implementation — same contract, no durability. */
export function createMemoryEngineStore(): EngineStore {
  const collections = new Map<string, Map<string, Uint8Array>>();
  let closed = false;
  const guard = (): void => {
    if (closed) {
      throw new EngineStoreError("closed", "engine store is closed");
    }
  };
  return {
    collection(name: string): EngineCollection {
      let table = collections.get(name);
      if (table === undefined) {
        table = new Map();
        collections.set(name, table);
      }
      return {
        get: async (key) => {
          guard();
          const value = table.get(key);
          return value === undefined ? undefined : new Uint8Array(value);
        },
        put: async (key, bytes) => {
          guard();
          table.set(key, new Uint8Array(bytes));
        },
        delete: async (key) => {
          guard();
          table.delete(key);
        },
        list: async () => {
          guard();
          return [...table.keys()];
        },
      };
    },
    close: async () => {
      closed = true;
      collections.clear();
    },
  };
}
