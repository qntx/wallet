import type { CloudStore, WalletEngine } from "@qntx/wallet-engine";
import {
  checkCloudName,
  checkCloudText,
  CloudStoreError,
  createGoogleDriveCloudStore,
} from "@qntx/wallet-engine";
import { createGoogleDriveStore, createICloudStore } from "@qntx/wallet-native/cloud";

/**
 * A host-written `CloudStore` drops `available()` and throws `CloudStoreError` — every
 * implementation must also pass the conformance suite (name and text rules, atomic writes,
 * delete-missing succeeds).
 */
export function hostStore(files: Map<string, string>, online: () => boolean): CloudStore {
  const reachable = (): void => {
    if (!online()) {
      throw new CloudStoreError("unavailable", "offline");
    }
  };
  return {
    // @ts-expect-error -- CloudStore no longer has available()
    available: async () => online(),
    list: async () => {
      reachable();
      return [...files.keys()];
    },
    read: async (name) => {
      checkCloudName(name);
      reachable();
      return files.get(name);
    },
    write: async (name, text) => {
      checkCloudName(name);
      checkCloudText(text);
      reachable();
      files.set(name, text);
    },
    delete: async (name) => {
      checkCloudName(name);
      reachable();
      files.delete(name);
    },
  };
}

/** React Native: the official transports. iOS takes the CloudKit container id from owner setup. */
export function nativeStore(platform: "ios" | "android"): CloudStore {
  return platform === "ios"
    ? createICloudStore({ container: "iCloud.org.example.wallet" })
    : createGoogleDriveStore();
}

/** ICloud account switches re-run the sync so the new account gets a copy. */
export function watchICloudAccount(engine: WalletEngine): () => void {
  const store = createICloudStore({ container: "iCloud.org.example.wallet" });
  return store.onAccountChange(() => {
    void engine.backup.sync();
  });
}

/** `auth-required` (Android/Web): run the consent from a user action, then sync again. */
export async function reauthorizeDrive(engine: WalletEngine): Promise<void> {
  const store = createGoogleDriveStore();
  const { status, error } = engine.backup.getState();
  if (status === "error" && error === "auth-required") {
    await store.authorize();
    await engine.backup.sync();
  }
}

/** Web: Google Drive appDataFolder with a Google Identity Services token client. */
export function webDriveStore(requestToken: () => Promise<string>): CloudStore {
  let cached: string | undefined;
  return createGoogleDriveCloudStore({
    fetch: async (input, init) => globalThis.fetch(input, init),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => {
        clearTimeout(id);
      };
    },
    token: async () => {
      cached ??= await requestToken();
      return cached;
    },
    invalidateToken: async (token) => {
      if (cached === token) {
        cached = undefined;
      }
      await Promise.resolve();
    },
  });
}

/**
 * `list()` returns every version, grouped here by backup id: several versions of one id mean two
 * devices updated it concurrently — restore each into the same vault to merge them.
 */
export async function backupsById(
  engine: WalletEngine,
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  const byId = new Map<string, string[]>();
  for (const { id, name } of await engine.backup.list()) {
    byId.set(id, [...(byId.get(id) ?? []), name]);
  }
  return byId;
}
