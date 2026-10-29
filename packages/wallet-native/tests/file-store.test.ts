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

const fakeFile = (initial?: Uint8Array): KernelFile & { image: () => unknown } => {
  let bytes: Uint8Array | null = initial ?? null;
  return {
    read: () => bytes,
    write: (b) => {
      bytes = b;
    },
    image: () => (bytes === null ? undefined : decode(bytes)),
  };
};

const META = {
  format: 2,
  revision: 1,
  keyId: "0123456789abcdef0123456789abcdef",
  failedAttempts: 0,
  lastFailureAt: 0,
};

describe("createFileStore", () => {
  it("init, put-record, reload round-trips through the file", async () => {
    const file = fakeFile();
    const store = createFileStore(file);
    await store.commit([{ op: "init", meta: META }]);
    await store.commit([
      { op: "expect-revision", revision: 1 },
      {
        op: "put-record",
        record: { kind: "entropy", id: "w1", header: "{}", sealed: new Uint8Array(16) },
      },
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

  it("a failing write leaves file and memory at the previous state", async () => {
    let bytes: Uint8Array | null = null;
    const okWrite = (b: Uint8Array): void => {
      bytes = b;
    };
    const failWrite = (): void => {
      throw new Error("disk full");
    };
    let write = okWrite;
    const file: KernelFile = {
      read: () => bytes,
      write: (b) => write(b),
    };
    const store = createFileStore(file);
    await store.commit([{ op: "init", meta: META }]);
    write = failWrite;
    await expect(
      store.commit([
        { op: "expect-revision", revision: 1 },
        {
          op: "put-record",
          record: { kind: "entropy", id: "w1", header: "{}", sealed: new Uint8Array(16) },
        },
      ]),
    ).rejects.toThrow("disk full");
    // The failed commit left nothing behind: load is still the initialized-only image, and the
    // next commit applies on the persisted revision, not the lost one.
    write = okWrite;
    const recovered = await store.load();
    expect(recovered.records).toHaveLength(0);
    await store.commit([
      { op: "expect-revision", revision: 1 },
      {
        op: "put-record",
        record: { kind: "entropy", id: "w1", header: "{}", sealed: new Uint8Array(16) },
      },
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
