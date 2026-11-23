/**
 * The shared CloudStore conformance suite — every implementation (memory, Google Drive, the
 * wallet-native wrappers) runs it against a fresh instance per case. `fault` lets a factory inject
 * the provider faults the port promises to map (S9); factories without fault injection skip those
 * cases.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_NAME_MAX_LENGTH,
  CLOUD_TEXT_MAX_BYTES,
  CloudStoreError,
} from "../../src/backup/port.ts";
import type { CloudStore } from "../../src/backup/port.ts";

export type CloudStoreFault = "unavailable" | "auth-required" | "quota";

export type CloudStoreRig = {
  readonly store: CloudStore;
  /** Arms the next call of `op` to fail with this provider fault. */
  readonly fault?: (op: "list" | "read" | "write" | "delete", kind: CloudStoreFault) => void;
};

const FAULT_KINDS: ReadonlyArray<CloudStoreFault> = ["unavailable", "auth-required", "quota"];
const OPS: ReadonlyArray<"list" | "read" | "write" | "delete"> = [
  "list",
  "read",
  "write",
  "delete",
];

const VALID_BACKUP_NAME = `qntx-wallet-backup-${"a".repeat(32)}-${"b".repeat(64)}.json`;

async function cloudError(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function callOp(
  store: CloudStore,
  op: "list" | "read" | "write" | "delete",
): Promise<unknown> {
  if (op === "list") {
    return store.list();
  }
  if (op === "read") {
    return store.read("doc.txt");
  }
  if (op === "write") {
    return store.write("doc.txt", "v");
  }
  return store.delete("doc.txt");
}

export function describeCloudStore(
  name: string,
  create: () => Promise<CloudStoreRig> | CloudStoreRig,
): void {
  describe(`CloudStore: ${name}`, () => {
    it("S1: accepts valid names, rejects invalid ones on every op without touching the store", async () => {
      const { store } = await create();
      const valid = ["a", "Z9.-_z", "x".repeat(CLOUD_NAME_MAX_LENGTH), VALID_BACKUP_NAME];
      for (const good of valid) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one name at a time keeps failures readable
        await store.write(good, "v");
        // oxlint-disable-next-line eslint/no-await-in-loop -- one name at a time keeps failures readable
        await expect(store.read(good)).resolves.toBe("v");
        // oxlint-disable-next-line eslint/no-await-in-loop -- one name at a time keeps failures readable
        await store.delete(good);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one name at a time keeps failures readable
        await expect(store.read(good)).resolves.toBeUndefined();
      }
      const before = await store.list();
      const invalid = ["", "x".repeat(256), ".x", "_x", "a/b", "a b", "a'b", "é", String.raw`a\b`];
      for (const bad of invalid) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one name at a time keeps failures readable
        expect(await cloudError(store.read(bad))).toMatchObject({
          name: "CloudStoreError",
          code: "invalid",
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- one name at a time keeps failures readable
        expect(await cloudError(store.write(bad, "v"))).toMatchObject({
          name: "CloudStoreError",
          code: "invalid",
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- one name at a time keeps failures readable
        expect(await cloudError(store.delete(bad))).toMatchObject({
          name: "CloudStoreError",
          code: "invalid",
        });
      }
      expect(await store.list()).toStrictEqual(before);
    });

    it("S2: texts round-trip up to the byte cap; oversize and lone surrogates reject", async () => {
      const { store } = await create();
      const max = "x".repeat(CLOUD_TEXT_MAX_BYTES);
      await store.write("big.txt", max);
      await expect(store.read("big.txt")).resolves.toBe(max);
      expect(await cloudError(store.write("big.txt", `${max}x`))).toMatchObject({
        name: "CloudStoreError",
        code: "invalid",
      });
      const unicode = "é𝄞🎉中文";
      await store.write("uni.txt", unicode);
      await expect(store.read("uni.txt")).resolves.toBe(unicode);
      expect(await cloudError(store.write("uni.txt", "lone \uD800surrogate"))).toMatchObject({
        name: "CloudStoreError",
        code: "invalid",
      });
    });

    it("S3/S4: a missing name reads undefined; a written text reads back exactly", async () => {
      const { store } = await create();
      await expect(store.read("missing.txt")).resolves.toBeUndefined();
      const text = 'exactly this\nwith "quotes" and {} [] 😀';
      await store.write("doc.txt", text);
      await expect(store.read("doc.txt")).resolves.toBe(text);
    });

    it("S5: an overwrite reads the second text and lists the name once", async () => {
      const { store } = await create();
      await store.write("doc.txt", "first");
      await store.write("doc.txt", "second");
      await expect(store.read("doc.txt")).resolves.toBe("second");
      const listed = await store.list();
      expect(listed.filter((n) => n === "doc.txt")).toHaveLength(1);
    });

    it("S6: list returns exactly the written set, once each", async () => {
      const { store } = await create();
      const names = Array.from({ length: 9 }, (_, i) => `file-${i}.txt`);
      await Promise.all(names.map(async (n) => store.write(n, `text ${n}`)));
      const listed = await store.list();
      expect(listed).toHaveLength(new Set(listed).size);
      expect(new Set(listed)).toStrictEqual(new Set(names));
    });

    it("S7: delete removes a file; deleting a missing name resolves", async () => {
      const { store } = await create();
      await store.write("doc.txt", "v");
      await store.delete("doc.txt");
      await expect(store.read("doc.txt")).resolves.toBeUndefined();
      await expect(store.list()).resolves.toStrictEqual([]);
      await expect(store.delete("doc.txt")).resolves.toBeUndefined();
      await expect(store.delete("never.txt")).resolves.toBeUndefined();
    });

    it("S8: concurrent same-name writes converge to one text, listed once", async () => {
      const { store } = await create();
      await Promise.all([store.write("doc.txt", "a"), store.write("doc.txt", "b")]);
      const text = await store.read("doc.txt");
      expect(["a", "b"]).toContain(text);
      const listed = await store.list();
      expect(listed.filter((n) => n === "doc.txt")).toHaveLength(1);
    });

    it("S9: provider faults surface as typed CloudStoreError and the store recovers", async () => {
      const rig = await create();
      if (rig.fault === undefined) {
        return;
      }
      for (const op of OPS) {
        for (const kind of FAULT_KINDS) {
          rig.fault(op, kind);
          // oxlint-disable-next-line eslint/no-await-in-loop -- faults arm one call and must run serially
          const error = await cloudError(callOp(rig.store, op));
          expect(error).toBeInstanceOf(CloudStoreError);
          expect(error).toMatchObject({ code: kind });
          // The store still works afterwards.
          // oxlint-disable-next-line eslint/no-await-in-loop -- faults arm one call and must run serially
          await rig.store.write("doc.txt", "v");
          // oxlint-disable-next-line eslint/no-await-in-loop -- faults arm one call and must run serially
          await expect(rig.store.read("doc.txt")).resolves.toBe("v");
          // oxlint-disable-next-line eslint/no-await-in-loop -- faults arm one call and must run serially
          await rig.store.delete("doc.txt");
        }
      }
    });

    it("a read concurrent with a write sees the old or the new text, never a prefix", async () => {
      const { store } = await create();
      const oldText = "old content complete";
      const newText = "new content complete and different";
      await store.write("doc.txt", oldText);
      const writing = store.write("doc.txt", newText);
      const seen = await store.read("doc.txt");
      await writing;
      expect([oldText, newText]).toContain(seen);
    });
  });
}
