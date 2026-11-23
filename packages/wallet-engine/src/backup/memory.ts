import { checkCloudName, checkCloudText } from "./port.ts";
import type { CloudStore } from "./port.ts";

const tick = Promise.resolve();

/** In-memory CloudStore for tests and the playground; swap the Map for cross-engine sharing. */
export function createMemoryCloudStore(backing?: Map<string, string>): CloudStore {
  const files = backing ?? new Map<string, string>();
  return {
    list: async () => {
      await tick;
      return [...files.keys()].sort();
    },
    read: async (name) => {
      checkCloudName(name);
      await tick;
      return files.get(name);
    },
    write: async (name, text) => {
      checkCloudName(name);
      checkCloudText(text);
      await tick;
      files.set(name, text);
    },
    delete: async (name) => {
      checkCloudName(name);
      await tick;
      files.delete(name);
    },
  };
}
