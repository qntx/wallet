/**
 * The `AppStorage` factory: per-app records in the session EngineStore, collection `apps.<id>`,
 * keys `${walletId}/${groupIndex}/${name}` (design.md 不变量 4′/12 — records are group-scoped and
 * their `walletId` prefix is what the wallet-deletion prune matches). Available only while the
 * controller's session store is open — every method throws `EngineStoreError("closed")` after a
 * lock.
 */
import { EngineStoreError } from "../errors.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";
import type { AppGroup, AppId, AppStorage } from "./types.ts";

/**
 * `store` resolves the currently open session store — `createApps` tracks the facade it hands the
 * controller; tests bind a memory store directly.
 */
const key = (group: AppGroup, name: string): string =>
  `${group.walletId}/${group.groupIndex}/${name}`;

export function createAppStorage(id: AppId, store: () => EngineStore | undefined): AppStorage {
  const collection = (): EngineCollection => {
    const session = store();
    if (session === undefined) {
      throw new EngineStoreError("closed", "the vault is locked");
    }
    return session.collection(`apps.${id}`);
  };
  return {
    get: async (group, name) => collection().get(key(group, name)),
    put: async (group, name, bytes) => collection().put(key(group, name), bytes),
    delete: async (group, name) => collection().delete(key(group, name)),
    groups: async () => {
      const seen = new Map<string, AppGroup>();
      for (const stored of await collection().list()) {
        /* A record key is `<walletId>/<groupIndex>/<name>` — anything shorter is not a
           group record. */
        const first = stored.indexOf("/");
        const second = stored.indexOf("/", first + 1);
        const groupIndex = Number(stored.slice(first + 1, second));
        if (first < 1 || second < first + 2 || !Number.isInteger(groupIndex) || groupIndex < 0) {
          continue;
        }
        const walletId = stored.slice(0, first);
        seen.set(`${walletId}/${groupIndex}`, { walletId, groupIndex });
      }
      return [...seen.values()];
    },
  };
}
