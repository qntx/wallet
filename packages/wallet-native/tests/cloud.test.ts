import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CloudStoreError } from "@qntx/wallet-engine";

import { describeCloudStore } from "../../wallet-engine/tests/cloud/conformance.ts";
import { createFakeDrive } from "../../wallet-engine/tests/fixtures/fake-drive.ts";
import { createGoogleDriveStore, createICloudStore } from "../src/cloud.ts";
import type { CloudKitStoreLike, GoogleDriveAuthLike } from "../src/cloud.ts";

const createHybridObject = vi.fn();
vi.mock("react-native-nitro-modules", () => ({
  NitroModules: {
    createHybridObject: (...args: ReadonlyArray<unknown>) => createHybridObject(...args),
  },
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  createHybridObject.mockReset();
});

/** An in-memory CloudKitStore: `failWith` arms the next native call to throw the raw message. */
function fakeCloudKit(): CloudKitStoreLike & { failWith: (message: string) => void } {
  const files = new Map<string, string>();
  let failure: string | undefined;
  const check = (): void => {
    const armed = failure;
    failure = undefined;
    if (armed !== undefined) {
      throw new Error(armed);
    }
  };
  return {
    failWith: (message) => {
      failure = message;
    },
    list: async () => {
      check();
      await Promise.resolve();
      return [...files.keys()];
    },
    read: async (_container, name) => {
      check();
      await Promise.resolve();
      return files.get(name);
    },
    write: async (_container, name, text) => {
      check();
      await Promise.resolve();
      files.set(name, text);
    },
    remove: async (_container, name) => {
      check();
      await Promise.resolve();
      files.delete(name);
    },
    setAccountListener: () => undefined,
  };
}

describeCloudStore("icloud", () => {
  const native = fakeCloudKit();
  return {
    store: createICloudStore({ container: "iCloud.org.qntx.test", native }),
    fault: (_op, kind) => native.failWith(`[qntx-cloud:${kind}] native detail`),
  };
});

/** A fake Google auth: every accessToken/clearToken call is recorded; `failWith` arms errors. */
function fakeGoogleAuth(tokens: ReadonlyArray<string> = ["tok"]): GoogleDriveAuthLike & {
  calls: Array<readonly [string, string | boolean]>;
  failWith: (message: string) => void;
} {
  let failure: string | undefined;
  let minted = 0;
  const queue = [...tokens];
  const state = {
    calls: [] as Array<readonly [string, string | boolean]>,
    failWith: (message: string) => {
      failure = message;
    },
    accessToken: async (interactive: boolean) => {
      state.calls.push(["accessToken", interactive]);
      await Promise.resolve();
      const armed = failure;
      failure = undefined;
      if (armed !== undefined) {
        throw new Error(armed);
      }
      minted += 1;
      return queue.shift() ?? `tok-${minted}`;
    },
    clearToken: async (token: string) => {
      state.calls.push(["clearToken", token]);
      await Promise.resolve();
    },
  };
  return state;
}

describeCloudStore("google-drive", () => {
  const drive = createFakeDrive({ pageSize: 3 });
  vi.stubGlobal("fetch", drive.fetch);
  const native = fakeGoogleAuth();
  return {
    store: createGoogleDriveStore({ native }),
    fault: (_op, kind) => native.failWith(`[qntx-cloud:${kind}] native detail`),
  };
});

describe("createICloudStore", () => {
  it("rejects a malformed container name before any native call", () => {
    const native = fakeCloudKit();
    for (const bad of ["", "org.qntx", "iCloud.", "iCloud.a b", "icloud.org.qntx"]) {
      expect(() => createICloudStore({ container: bad, native })).toThrow(CloudStoreError);
    }
    expect(() => createICloudStore({ container: "iCloud.org.qntx.test", native })).not.toThrow();
  });

  it("decodes native failures into the typed code, missing token → failed", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["[qntx-cloud:unavailable] network", "unavailable"],
      ["[qntx-cloud:auth-required] needs-consent", "auth-required"],
      ["[qntx-cloud:quota] storage full", "quota"],
      ["[qntx-cloud:failed] corrupt", "failed"],
      ["[qntx-cloud:bogus] unknown", "failed"],
      ["plain failure without a token", "failed"],
      ["", "failed"],
    ];
    await Promise.all(
      cases.map(async ([message, want]) => {
        const native = fakeCloudKit();
        native.failWith(message);
        const store = createICloudStore({ container: "iCloud.org.qntx.test", native });
        const error = await store.list().then(
          () => undefined,
          (error_: unknown) => error_,
        );
        expect(error).toBeInstanceOf(CloudStoreError);
        expect(error).toMatchObject({ code: want });
      }),
    );
  });

  it("fans an account change out to every listener once per native registration", async () => {
    let nativeListener: (() => void) | undefined;
    let registrations = 0;
    const native = fakeCloudKit();
    const recording: CloudKitStoreLike = {
      ...native,
      setAccountListener: (listener) => {
        registrations += 1;
        nativeListener = listener;
      },
    };
    const store = createICloudStore({ container: "iCloud.org.qntx.test", native: recording });
    const hits: number[] = [];
    const off1 = store.onAccountChange(() => hits.push(1));
    store.onAccountChange(() => hits.push(2));
    await new Promise((resolve) => setTimeout(resolve));
    expect(registrations).toBe(1);
    nativeListener?.();
    nativeListener?.();
    expect(hits).toStrictEqual([1, 2, 1, 2]);
    off1();
    nativeListener?.();
    expect(hits).toStrictEqual([1, 2, 1, 2, 2]);
  });

  it("creates the Nitro hybrid lazily on first use", async () => {
    const native = fakeCloudKit();
    createHybridObject.mockReturnValue(native);
    const store = createICloudStore({ container: "iCloud.org.qntx.test" });
    expect(createHybridObject).not.toHaveBeenCalled();
    await store.list();
    expect(createHybridObject).toHaveBeenCalledWith("CloudKitStore");
  });
});

describe("createGoogleDriveStore", () => {
  it("authorize() calls accessToken(true); operations use accessToken(false)", async () => {
    const drive = createFakeDrive();
    vi.stubGlobal("fetch", drive.fetch);
    const native = fakeGoogleAuth();
    const store = createGoogleDriveStore({ native });
    await store.authorize();
    expect(native.calls).toStrictEqual([["accessToken", true]]);
    native.calls.length = 0;
    await store.list();
    expect(native.calls).toStrictEqual([["accessToken", false]]);
  });

  it("a Drive 401 clears the old token and re-auths silently", async () => {
    const drive = createFakeDrive();
    drive.files.set("f1", { id: "f1", name: "a.txt", text: "x" });
    vi.stubGlobal("fetch", drive.fetch);
    const native = fakeGoogleAuth(["stale", "fresh"]);
    const store = createGoogleDriveStore({ native });
    drive.revoke("stale");
    await store.write("a.txt", "v");
    expect(native.calls).toStrictEqual([
      ["accessToken", false],
      ["clearToken", "stale"],
      ["accessToken", false],
      ["accessToken", false],
    ]);
    expect([...drive.files.values()].map((f) => f.text)).toContain("v");
  });

  it("creates the Nitro hybrid lazily on first use", async () => {
    const drive = createFakeDrive();
    vi.stubGlobal("fetch", drive.fetch);
    const native = fakeGoogleAuth();
    createHybridObject.mockReturnValue(native);
    const store = createGoogleDriveStore();
    expect(createHybridObject).not.toHaveBeenCalled();
    await store.list();
    expect(createHybridObject).toHaveBeenCalledWith("GoogleDriveAuth");
  });

  it("decodes auth-native failures into the typed code", async () => {
    const kinds = ["unavailable", "auth-required", "quota"] as const;
    await Promise.all(
      kinds.map(async (kind) => {
        const drive = createFakeDrive();
        vi.stubGlobal("fetch", drive.fetch);
        const native = fakeGoogleAuth();
        native.failWith(`[qntx-cloud:${kind}] native detail`);
        const store = createGoogleDriveStore({ native });
        const error = await store.list().then(
          () => undefined,
          (error_: unknown) => error_,
        );
        expect(error).toBeInstanceOf(CloudStoreError);
        expect(error).toMatchObject({ code: kind });
      }),
    );
  });
});
