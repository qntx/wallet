import { describe, expect, it, vi } from "vite-plus/test";

import { createMemoryAnchor } from "../src/vault/anchor.ts";
import { createMemoryStore } from "../src/vault/memory.ts";
import type { StoredFactor, StoredRecord, VaultImage, VaultMeta } from "../src/vault/store.ts";
import { VAULT_FORMAT } from "../src/vault/store.ts";

const empty: VaultImage = { meta: undefined, records: [], factors: [] };

const meta: VaultMeta = {
  format: VAULT_FORMAT,
  revision: 1,
  keyId: "a".repeat(32),
};

const record: StoredRecord = {
  kind: "entropy",
  id: "aa",
  sealed: new Uint8Array([1, 2, 3]),
  header:
    '{"walletId":"6e0d11a50c03aa4f","origin":"mnemonic","words":12,"backup":"none","createdAt":0}',
};

const factor: StoredFactor = {
  kind: "password",
  id: "bb",
  sealed: new Uint8Array([9]),
  header: "{}",
};

describe("memory store", () => {
  it("returns an empty image before any commit", async () => {
    const store = createMemoryStore();
    await expect(store.load()).resolves.toStrictEqual(empty);
  });

  it("init applies ops atomically and watch fires", async () => {
    const store = createMemoryStore();
    const watcher = vi.fn();
    store.watch(watcher);
    await store.commit([
      { op: "init", meta },
      { op: "put-record", record },
    ]);
    expect(watcher).toHaveBeenCalledTimes(1);
    const loaded = await store.load();
    // init writes the meta verbatim — the content op in the same commit does not bump it
    expect(loaded.meta).toStrictEqual(meta);
    expect(loaded.records).toStrictEqual([record]);
  });

  it("a failing init writes nothing", async () => {
    const store = createMemoryStore();
    await store.commit([{ op: "init", meta }]);
    const before = await store.load();
    await expect(
      store.commit([
        { op: "init", meta },
        { op: "put-record", record },
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.load()).resolves.toStrictEqual(before);
  });

  it("content commits bump the revision by one", async () => {
    const store = createMemoryStore();
    await store.commit([{ op: "init", meta }]);
    await store.commit([
      { op: "expect-revision", revision: 1 },
      { op: "put-record", record },
    ]);
    await store.commit([{ op: "put-factor", factor }]);
    const loaded = await store.load();
    expect(loaded.meta).toStrictEqual({ ...meta, revision: 3 });
  });

  it("expect-revision mismatch fails with conflict and writes nothing", async () => {
    const store = createMemoryStore();
    await store.commit([
      { op: "init", meta },
      { op: "put-factor", factor },
    ]);
    const before = await store.load();
    await expect(
      store.commit([
        { op: "expect-revision", revision: 99 },
        { op: "delete-factor", id: "bb" },
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.load()).resolves.toStrictEqual(before);
  });

  it("the memory anchor writes only when the expected bytes match", async () => {
    const anchor = createMemoryAnchor();
    await expect(anchor.read()).resolves.toBeUndefined();
    // Nothing stored: only an `undefined` expectation may write.
    await expect(anchor.replace(new Uint8Array([1]), new Uint8Array(21))).resolves.toBe(false);
    const first = new Uint8Array(21).fill(9);
    await expect(anchor.replace(first, undefined)).resolves.toBe(true);
    const stale = new Uint8Array(21).fill(3);
    await expect(anchor.replace(stale, new Uint8Array(21).fill(1))).resolves.toBe(false);
    await expect(anchor.read()).resolves.toStrictEqual(first);
    await expect(anchor.replace(stale, first)).resolves.toBe(true);
    await expect(anchor.read()).resolves.toStrictEqual(stale);
  });

  it("the memory anchor copies bytes in and out", async () => {
    const anchor = createMemoryAnchor();
    const written = new Uint8Array(21).fill(5);
    await anchor.replace(written, undefined);
    written.fill(0);
    const read = await anchor.read();
    expect(read).toStrictEqual(new Uint8Array(21).fill(5));
    read?.fill(0);
    await expect(anchor.read()).resolves.toStrictEqual(new Uint8Array(21).fill(5));
  });

  it("set-key-id changes keyId and bumps the revision", async () => {
    const store = createMemoryStore();
    await store.commit([{ op: "init", meta }]);
    await store.commit([{ op: "set-key-id", keyId: "b".repeat(32) }]);
    const loaded = await store.load();
    expect(loaded.meta).toStrictEqual({ ...meta, keyId: "b".repeat(32), revision: 2 });
  });

  it("load returns copies, not the stored buffers", async () => {
    const store = createMemoryStore();
    await store.commit([{ op: "put-record", record }]);
    const loaded = await store.load();
    loaded.records[0]!.sealed.fill(0);
    const reloaded = await store.load();
    expect(reloaded.records[0]!.sealed).toStrictEqual(new Uint8Array([1, 2, 3]));
  });

  it("committing a record does not alias the caller's buffer", async () => {
    const store = createMemoryStore();
    const caller = { ...record, sealed: new Uint8Array([1, 2, 3]) };
    await store.commit([{ op: "put-record", record: caller }]);
    caller.sealed.fill(0);
    const loaded = await store.load();
    expect(loaded.records[0]!.sealed).toStrictEqual(new Uint8Array([1, 2, 3]));
  });

  it("delete-record, delete-factor and clear work", async () => {
    const store = createMemoryStore();
    await store.commit([
      { op: "init", meta },
      { op: "put-record", record },
      { op: "put-factor", factor },
    ]);
    await store.commit([{ op: "delete-record", kind: "entropy", id: "aa" }]);
    const afterDeleteRecord = await store.load();
    expect(afterDeleteRecord.records).toStrictEqual([]);
    await store.commit([{ op: "delete-factor", id: "bb" }]);
    const afterDeleteFactor = await store.load();
    expect(afterDeleteFactor.factors).toStrictEqual([]);
    await store.commit([{ op: "clear" }]);
    await expect(store.load()).resolves.toStrictEqual(empty);
  });
});
