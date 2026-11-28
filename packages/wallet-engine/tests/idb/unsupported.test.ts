/**
 * Vectors/unsupported.json `engineDb`/`publicDb` — an engine IndexedDB database below the current
 * version is refused `unsupported`/`older` and left intact (never wiped: the explicit discard is
 * the host's `indexedDB.deleteDatabase(name)`); above it, `VersionError` maps to
 * `unsupported`/`newer`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import { EngineStoreError } from "../../src/errors.ts";
import { openIndexedDbEngineStore, openIndexedDbPublicStore } from "../../src/idb/indexeddb.ts";

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../vectors/unsupported.json", import.meta.url)),
    "utf8",
  ),
) as {
  engineDb: {
    cases: Array<{
      name: string;
      version: number;
      expect: "ok" | { status: "unsupported"; reason: "older" | "newer" };
    }>;
  };
  publicDb: {
    cases: Array<{
      name: string;
      version: number;
      expect: { status: "unsupported"; reason: string };
    }>;
  };
};

const DATA_KEY = new Uint8Array(32).fill(7);
const random = (n: number) => new Uint8Array(n).fill(3);

function useFakeIdb(): void {
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
}

/** A database at `version` holding the object stores plus a marker row the test reads back. */
async function seedDb(name: string, version: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(name, version);
    open.addEventListener("upgradeneeded", (event) => {
      const tx = open.transaction;
      if (tx === null) {
        reject(new Error("no upgrade transaction"));
        return;
      }
      if (event.oldVersion === 0) {
        open.result.createObjectStore("records");
        open.result.createObjectStore("index");
      }
      tx.objectStore("records").put("still-here", "marker");
    });
    open.addEventListener("success", () => {
      open.result.close();
      resolve();
    });
    open.addEventListener("error", () => reject(open.error ?? new Error("seed failed")));
  });
}

async function openRaw(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, version);
    open.addEventListener("success", () => resolve(open.result));
    open.addEventListener("error", () => reject(open.error ?? new Error("open failed")));
  });
}

async function markerOf(name: string, version: number): Promise<unknown> {
  const db = await openRaw(name, version);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const get = db.transaction("records", "readonly").objectStore("records").get("marker");
      get.addEventListener("success", () => resolve(get.result));
      get.addEventListener("error", () => reject(get.error ?? new Error("get failed")));
    });
  } finally {
    db.close();
  }
}

type Verdict = "ok" | { code: string; reason: string | undefined };

/** The verdict of opening the engine store on a vector database: "ok", or the refusal. */
const engineVerdict = async (name: string): Promise<Verdict> => {
  try {
    const store = await openIndexedDbEngineStore({ name, dataKey: DATA_KEY, random });
    await store.close();
    return "ok";
  } catch (error) {
    if (error instanceof EngineStoreError) {
      return { code: error.code, reason: error.reason };
    }
    throw error;
  }
};

const publicVerdict = async (name: string): Promise<Verdict> => {
  try {
    await openIndexedDbPublicStore({ name });
    return "ok";
  } catch (error) {
    if (error instanceof EngineStoreError) {
      return { code: error.code, reason: error.reason };
    }
    throw error;
  }
};

const wanted = (expected: "ok" | { reason: string }): Verdict =>
  expected === "ok" ? "ok" : { code: "unsupported", reason: expected.reason };

describe("indexeddb format direction", () => {
  it.each(vectors.engineDb.cases)("engineDb $name", async ({ version, expect: expected }) => {
    useFakeIdb();
    const name = `t-${Math.random().toString(36).slice(2)}`;
    await seedDb(name, version);
    await expect(engineVerdict(name)).resolves.toStrictEqual(wanted(expected));
  });

  it.each(vectors.engineDb.cases.filter((c) => c.expect !== "ok"))(
    "engineDb $name leaves the database intact",
    async ({ version }) => {
      useFakeIdb();
      // A refused open never wipes: the seeded row is still there.
      const name = `t-${Math.random().toString(36).slice(2)}`;
      await seedDb(name, version);
      await expect(markerOf(name, version)).resolves.toBe("still-here");
      await engineVerdict(name);
      await expect(markerOf(name, version)).resolves.toBe("still-here");
    },
  );

  it.each(vectors.publicDb.cases)("publicDb $name", async ({ version, expect: expected }) => {
    useFakeIdb();
    const name = `t-${Math.random().toString(36).slice(2)}`;
    await seedDb(name, version);
    await expect(publicVerdict(name)).resolves.toStrictEqual(wanted(expected));
    await expect(markerOf(name, version)).resolves.toBe("still-here");
  });
});
