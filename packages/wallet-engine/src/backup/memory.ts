import type { CloudStore } from "./port.ts";

const tick = Promise.resolve();

/** In-memory CloudStore for tests and the playground; swap the Map for cross-engine sharing. */
export function createMemoryCloudStore(backing?: Map<string, string>): CloudStore {
  const files = backing ?? new Map<string, string>();
  let reachable = true;
  const store: CloudStore & { readonly setReachable: (v: boolean) => void } = {
    available: async () => {
      await tick;
      return reachable;
    },
    list: async () => {
      await tick;
      return [...files.keys()].sort();
    },
    read: async (name) => {
      await tick;
      return files.get(name);
    },
    write: async (name, text) => {
      await tick;
      files.set(name, text);
    },
    delete: async (name) => {
      await tick;
      files.delete(name);
    },
    setReachable: (v) => {
      reachable = v;
    },
  };
  return store;
}
