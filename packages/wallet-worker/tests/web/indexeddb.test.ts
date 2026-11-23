import { beforeEach, describe, expect, it } from "vite-plus/test";

import { KernelError, VAULT_FORMAT, createMemoryStore } from "@qntx/wallet-kernel";
import type { RecordStore, StoreOp, VaultImage, VaultMeta } from "@qntx/wallet-kernel";

import { createIndexedDbStore } from "../../src/worker/indexeddb.ts";

const DB_NAME = "qntx-wallet";

async function settled(request: IDBOpenDBRequest): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => {
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("indexeddb request failed"));
    });
  });
}

beforeEach(async () => {
  // Stores of earlier tests close their connection on this request's versionchange.
  await settled(indexedDB.deleteDatabase(DB_NAME));
});

const META: VaultMeta = {
  format: VAULT_FORMAT,
  revision: 1,
  keyId: "0".repeat(32),
};

const record = (kind: string, id: string, fill: number) => ({
  kind,
  id,
  header: JSON.stringify({ createdAt: fill }),
  sealed: new Uint8Array(48).fill(fill),
});

const factor = (index: number, fill: number) => ({
  kind: "password",
  id: index.toString(16).padStart(32, "0"),
  header: JSON.stringify({ createdAt: fill }),
  sealed: new Uint8Array(48).fill(fill),
});

/** A deterministic stream of commits that mixes every op, valid and conflicting. */
function commits(seed: number, count: number): ReadonlyArray<ReadonlyArray<StoreOp>> {
  let state = seed;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) % 4_294_967_296;
    return Math.abs(state) % bound;
  };
  const one = (): StoreOp => {
    const choices: ReadonlyArray<StoreOp> = [
      { op: "init", meta: META },
      { op: "expect-revision", revision: 1 + next(4) },
      { op: "set-key-id", keyId: next(16).toString(16).repeat(32) },
      { op: "put-record", record: record("entropy", `w${next(3)}`, next(255)) },
      { op: "put-record", record: record("key", `k${next(3)}`, next(255)) },
      { op: "delete-record", kind: "entropy", id: `w${next(3)}` },
      { op: "put-factor", factor: factor(next(3), next(255)) },
      { op: "delete-factor", id: next(3).toString(16).padStart(32, "0") },
      { op: "clear" },
    ];
    return choices[next(choices.length)] ?? { op: "clear" };
  };
  return Array.from({ length: count }, () => Array.from({ length: 1 + next(3) }, one));
}

const sorted = (image: VaultImage): VaultImage => ({
  meta: image.meta,
  records: image.records.toSorted((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`)),
  factors: image.factors.toSorted((a, b) => a.id.localeCompare(b.id)),
});

const outcome = async (store: RecordStore, ops: ReadonlyArray<StoreOp>): Promise<string> => {
  try {
    await store.commit(ops);
    return "committed";
  } catch (error) {
    return error instanceof KernelError ? error.code : "error";
  }
};

describe("IndexedDB vault store", () => {
  it.each([1, 2, 3, 4])(
    "matches the reference store on every commit of stream %i",
    async (seed) => {
      const reference = createMemoryStore();
      const store = createIndexedDbStore();
      for (const ops of commits(seed, 60)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each commit builds on the previous image
        const [expected, actual] = [await outcome(reference, ops), await outcome(store, ops)];
        expect({ ops, outcome: actual }).toStrictEqual({ ops, outcome: expected });
        // oxlint-disable-next-line eslint/no-await-in-loop -- compared after every commit
        expect(sorted(await store.load())).toStrictEqual(sorted(await reference.load()));
      }
    },
  );

  it("a clear after other changes in the same commit leaves the store empty", async () => {
    const store = createIndexedDbStore();
    await store.commit([{ op: "init", meta: META }]);
    await store.commit([
      { op: "put-record", record: record("entropy", "w0", 1) },
      { op: "set-key-id", keyId: "1".repeat(32) },
      { op: "clear" },
    ]);
    await expect(store.load()).resolves.toStrictEqual({
      meta: undefined,
      records: [],
      factors: [],
    });
  });

  it("a failed precondition writes nothing of its commit", async () => {
    const store = createIndexedDbStore();
    await store.commit([{ op: "init", meta: META }]);
    await expect(
      store.commit([
        { op: "put-record", record: record("entropy", "w0", 1) },
        { op: "expect-revision", revision: 99 },
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.load()).resolves.toStrictEqual({ meta: META, records: [], factors: [] });
  });

  it("persists across store instances and bumps the revision once per content commit", async () => {
    const first = createIndexedDbStore();
    await first.commit([{ op: "init", meta: META }]);
    await first.commit([
      { op: "put-record", record: record("entropy", "w0", 1) },
      { op: "put-factor", factor: factor(0, 2) },
    ]);
    const image = await createIndexedDbStore().load();
    expect(image.meta?.revision).toBe(2);
    expect(image.records).toHaveLength(1);
    expect(image.factors).toHaveLength(1);
  });

  it("tells other stores about a commit, never the one that made it", async () => {
    const writer = createIndexedDbStore();
    const reader = createIndexedDbStore();
    let own = 0;
    const stopOwn = writer.watch(() => {
      own += 1;
    });
    const heard = new Promise<void>((resolve) => {
      const stop = reader.watch(() => {
        stop();
        resolve();
      });
    });
    await writer.commit([{ op: "init", meta: META }]);
    await heard;
    stopOwn();
    expect(own).toBe(0);
  });

  it("fails closed on a row the page wrote behind its back", async () => {
    const store = createIndexedDbStore();
    await store.commit([{ op: "init", meta: META }]);
    const db = await settled(indexedDB.open(DB_NAME));
    const tx = db?.transaction("records", "readwrite");
    tx?.objectStore("records").put({ kind: "entropy", id: "w0", header: 7, sealed: "nope" });
    await new Promise((resolve) => {
      tx?.addEventListener("complete", resolve);
    });
    db?.close();
    await expect(store.load()).rejects.toMatchObject({ code: "integrity" });
  });

  it("reports a database from a newer build as unsupported, then recovers", async () => {
    const store = createIndexedDbStore();
    await store.commit([{ op: "init", meta: META }]);
    // Another tab upgrades the schema: this store closes on versionchange and reopens lazily.
    const newer = await settled(indexedDB.open(DB_NAME, 2));
    await expect(store.load()).rejects.toMatchObject({ code: "unsupported" });
    newer?.close();
    await settled(indexedDB.deleteDatabase(DB_NAME));
    await expect(store.load()).resolves.toStrictEqual({
      meta: undefined,
      records: [],
      factors: [],
    });
  });
});
