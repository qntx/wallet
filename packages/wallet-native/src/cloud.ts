import {
  checkCloudName,
  checkCloudText,
  CloudStoreError,
  createGoogleDriveCloudStore,
} from "@qntx/wallet-engine";
import type { CloudStore, CloudStoreErrorCode, SetTimer } from "@qntx/wallet-engine";

import type { CloudKitStore, GoogleDriveAuth } from "./specs/cloud.nitro.ts";

export type CloudKitStoreLike = Pick<
  CloudKitStore,
  "list" | "read" | "write" | "remove" | "setAccountListener"
>;
export type GoogleDriveAuthLike = Pick<GoogleDriveAuth, "accessToken" | "clearToken">;
export type ICloudStore = CloudStore & {
  /** Subscribes to iCloud account changes (sign-out, account switch); returns the unsubscribe. */
  readonly onAccountChange: (listener: () => void) => () => void;
};
export type GoogleDriveStore = CloudStore & {
  /** Runs the interactive consent flow — call from a user action after `auth-required`. */
  readonly authorize: () => Promise<void>;
};

const CLOUD_ERROR = /\[qntx-cloud:(unavailable|auth-required|quota|failed)\]/;
const CONTAINER_NAME = /^iCloud\.[A-Za-z0-9.-]+$/;

/** Decodes a native rejection into the typed fault; a missing token is `failed`. */
function decode(error: unknown): CloudStoreError {
  const message = error instanceof Error ? error.message : "native cloud call failed";
  const match = CLOUD_ERROR.exec(message)?.[1];
  const code: CloudStoreErrorCode =
    match === "unavailable" || match === "auth-required" || match === "quota" || match === "failed"
      ? match
      : "failed";
  return new CloudStoreError(code, message);
}

const call = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    throw decode(error);
  }
};

const setTimer: SetTimer = (ms, fn) => {
  const id = setTimeout(() => {
    fn();
  }, ms);
  return () => {
    clearTimeout(id);
  };
};

/**
 * The iCloud transport over the Nitro `CloudKitStore` hybrid. `native` is the test seam — by
 * default the hybrid is created lazily on first use through
 * `NitroModules.createHybridObject("CloudKitStore")`.
 */
export function createICloudStore(options: {
  readonly container: string;
  readonly native?: CloudKitStoreLike;
}): ICloudStore {
  if (!CONTAINER_NAME.test(options.container)) {
    throw new CloudStoreError("invalid", "iCloud container must look like iCloud.<identifier>");
  }
  let { native } = options;
  const store = async (): Promise<CloudKitStoreLike> => {
    if (native === undefined) {
      const { NitroModules } = await import("react-native-nitro-modules");
      native = NitroModules.createHybridObject<CloudKitStore>("CloudKitStore");
    }
    return native;
  };
  const listeners = new Set<() => void>();
  let registered = false;
  const register = async (): Promise<void> => {
    registered = true;
    const native = await store();
    native.setAccountListener(() => {
      for (const listener of listeners) {
        listener();
      }
    });
  };
  const callNative = async <T>(op: (native: CloudKitStoreLike) => Promise<T>): Promise<T> =>
    call(async () => {
      const native = await store();
      return op(native);
    });
  return {
    list: async () => callNative(async (native) => native.list(options.container)),
    read: async (name) => {
      checkCloudName(name);
      return callNative(async (native) => native.read(options.container, name));
    },
    write: async (name, text) => {
      checkCloudName(name);
      checkCloudText(text);
      return callNative(async (native) => native.write(options.container, name, text));
    },
    delete: async (name) => {
      checkCloudName(name);
      return callNative(async (native) => native.remove(options.container, name));
    },
    onAccountChange: (listener) => {
      listeners.add(listener);
      if (!registered) {
        void register();
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The Google Drive transport: the engine's `appDataFolder` adapter fed by the Nitro
 * `GoogleDriveAuth` hybrid for tokens. `native` is the test seam — by default the hybrid is created
 * lazily on first use through `NitroModules.createHybridObject("GoogleDriveAuth")`.
 */
export function createGoogleDriveStore(options?: {
  readonly native?: GoogleDriveAuthLike;
}): GoogleDriveStore {
  let native = options?.native;
  const auth = async (): Promise<GoogleDriveAuthLike> => {
    if (native === undefined) {
      const { NitroModules } = await import("react-native-nitro-modules");
      native = NitroModules.createHybridObject<GoogleDriveAuth>("GoogleDriveAuth");
    }
    return native;
  };
  const store = createGoogleDriveCloudStore({
    fetch: async (input, init) => globalThis.fetch(input, init),
    setTimer,
    token: async () =>
      call(async () => {
        const native = await auth();
        return native.accessToken(false);
      }),
    invalidateToken: async (token) =>
      call(async () => {
        const native = await auth();
        return native.clearToken(token);
      }),
  });
  return {
    ...store,
    authorize: async () => {
      await call(async () => {
        const native = await auth();
        await native.accessToken(true);
      });
    },
  };
}
