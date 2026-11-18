import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decode } from "cborg";
import { describe, expect, it } from "vite-plus/test";

import { createFileStore } from "../kernel/store.ts";
import type { KernelFile } from "../kernel/store.ts";
import { encodeFrame } from "../src/cbor.ts";

const vectors: { cases: Array<{ name: string; expect: string; frame: string }> } = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/native-vault-image.json"), "utf8"),
) as { cases: Array<{ name: string; expect: string; frame: string }> };

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((value, index) => value === b[index]));

/** A faithful CAS file: `replace` swaps only when the current bytes equal `expected`. */
const fakeFile = (initial?: Uint8Array): KernelFile & { image: () => unknown } => {
  let bytes: Uint8Array | undefined = initial;
  return {
    read: () => bytes,
    replace: (next, expected) => {
      if (!sameBytes(bytes, expected)) {
        return false;
      }
      bytes = next;
      return true;
    },
    image: () => (bytes === undefined ? undefined : decode(bytes)),
  };
};

/** A CAS file whose `replace` throws once `state.fail` is set — a mid-commit disk error. */
const flakyFile = (state: { fail: boolean }): KernelFile => {
  let bytes: Uint8Array | undefined;
  return {
    read: () => bytes,
    replace: (next, expected) => {
      if (state.fail) {
        throw new Error("disk full");
      }
      if (!sameBytes(bytes, expected)) {
        return false;
      }
      bytes = next;
      return true;
    },
  };
};

const META = {
  format: 5,
  revision: 1,
  keyId: "0123456789abcdef0123456789abcdef",
  failedAttempts: 0,
  lastFailureAt: 0,
};

const RECORD = {
  kind: "entropy",
  id: "w1",
  header: "{}",
  sealed: new Uint8Array(16),
} as const;

describe("createFileStore", () => {
  it("init, put-record, reload round-trips through the file", async () => {
    const file = fakeFile();
    const store = createFileStore(file);
    await store.commit([{ op: "init", meta: META }]);
    await store.commit([
      { op: "expect-revision", revision: 1 },
      { op: "put-record", record: { ...RECORD } },
    ]);

    const store2 = createFileStore(file);
    const image = await store2.load();
    expect(image.records).toHaveLength(1);
    expect(image.records[0]).toMatchObject({ kind: "entropy", id: "w1" });
    expect(image.meta?.revision).toBe(2);
  });

  it("a failed precondition writes nothing", async () => {
    const file = fakeFile();
    const store = createFileStore(file);
    await store.commit([{ op: "init", meta: META }]);
    const before = file.read();
    await expect(store.commit([{ op: "expect-revision", revision: 99 }])).rejects.toThrow(
      expect.any(Error),
    );
    expect(file.read()).toBe(before);
  });

  it("a failed precondition is judged against the file, not a cached image", async () => {
    const file = fakeFile();
    const store = createFileStore(file);
    const other = createFileStore(file);
    await store.commit([{ op: "init", meta: META }]);
    // A second writer moves the file to revision 2 behind `store`'s back.
    await other.commit([
      { op: "expect-revision", revision: 1 },
      { op: "put-record", record: { ...RECORD } },
    ]);
    // `store` commits against the file's truth (revision 2), not a stale view —
    // so expect-revision 1 conflicts while revision 2 applies cleanly.
    await expect(store.commit([{ op: "expect-revision", revision: 1 }])).rejects.toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    await store.commit([{ op: "expect-revision", revision: 2 }]);
    const image = await store.load();
    expect(image.meta?.revision).toBe(2);
    expect(image.records).toHaveLength(1);
  });

  it("a lost replace race rejects conflict and notifies no listener", async () => {
    const file = fakeFile();
    await createFileStore(file).commit([{ op: "init", meta: META }]);
    // A file that always loses the CAS: every commit must reject `conflict`.
    const losing: KernelFile = {
      read: () => file.read(),
      replace: () => false,
    };
    const store = createFileStore(losing);
    let fired = 0;
    store.watch(() => {
      fired += 1;
    });
    await expect(
      store.commit([
        { op: "expect-revision", revision: 1 },
        { op: "put-record", record: { ...RECORD } },
      ]),
    ).rejects.toThrow(expect.objectContaining({ code: "conflict" }));
    expect(fired).toBe(0);
    // Nothing was written: the file still holds only the init image.
    const image = await createFileStore(file).load();
    expect(image.records).toHaveLength(0);
  });

  it("a failing replace leaves the file at the previous state", async () => {
    const state = { fail: false };
    const file = flakyFile(state);
    const store = createFileStore(file);
    await store.commit([{ op: "init", meta: META }]);
    state.fail = true;
    await expect(
      store.commit([
        { op: "expect-revision", revision: 1 },
        { op: "put-record", record: { ...RECORD } },
      ]),
    ).rejects.toThrow("disk full");
    // The failed commit left nothing behind: load is still the initialized-only image, and the
    // next commit applies on the persisted revision, not the lost one.
    state.fail = false;
    const recovered = await store.load();
    expect(recovered.records).toHaveLength(0);
    await store.commit([
      { op: "expect-revision", revision: 1 },
      { op: "put-record", record: { ...RECORD } },
    ]);
    const after = await store.load();
    expect(after.records).toHaveLength(1);
  });

  it("watch fires after each commit", async () => {
    const file = fakeFile();
    const store = createFileStore(file);
    let fired = 0;
    store.watch(() => {
      fired += 1;
    });
    await store.commit([{ op: "init", meta: META }]);
    expect(fired).toBe(1);
  });

  it.each(vectors.cases.filter((c) => c.expect === "ok"))("vector ok $name", async (c) => {
    const store = createFileStore(fakeFile(Uint8Array.from(Buffer.from(c.frame, "hex"))));
    await expect(store.load()).resolves.toBeDefined();
  });

  it.each(vectors.cases.filter((c) => c.expect === "reject"))("vector reject $name", async (c) => {
    const store = createFileStore(fakeFile(Uint8Array.from(Buffer.from(c.frame, "hex"))));
    await expect(store.load()).rejects.toThrow(expect.any(Error));
  });

  it("a truncated or garbage file makes load reject, never silently empty", async () => {
    const garbage = fakeFile(Uint8Array.from([0xff, 0x61, 0x00]));
    const store = createFileStore(garbage);
    await expect(store.load()).rejects.toThrow(expect.any(Error));
    const truncated = fakeFile(
      Uint8Array.from(new Uint8Array(encodeFrame({ a: [1, 2, 3] })).slice(0, 3)),
    );
    await expect(createFileStore(truncated).load()).rejects.toThrow(expect.any(Error));
  });
});
