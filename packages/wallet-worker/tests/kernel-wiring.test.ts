import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";

import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMemoryStore } from "@qntx/wallet-kernel";

import { serveStore } from "../src/node/store-server.ts";
import { startNodeKernel } from "../src/worker/node-kernel.ts";
import { basePlatform } from "../src/worker/platform.ts";
import { loadSparkBackend } from "../src/worker/spark.ts";
import { subtlePbkdf2 } from "../src/worker/subtle.ts";

const SPARK_WASM = new URL("../dist/spark.wasm", import.meta.url);
const readSparkWasm = async (): Promise<Uint8Array> => new Uint8Array(await readFile(SPARK_WASM));

describe("subtlePbkdf2", () => {
  it("matches the RFC 7914 PBKDF2-HMAC-SHA-256 vector", async () => {
    const derived = await subtlePbkdf2("sha256", utf8ToBytes("passwd"), utf8ToBytes("salt"), 1, 64);
    expect(bytesToHex(derived)).toBe(
      "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
    );
  });

  it.each([
    ["sha256", sha256],
    ["sha512", sha512],
  ] as const)("agrees with an independent %s implementation", async (name, hash) => {
    const password = utf8ToBytes("correct horse battery staple");
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    const derived = await subtlePbkdf2(name, password, salt, 2048, 48);
    expect(derived).toStrictEqual(pbkdf2(hash, password, salt, { c: 2048, dkLen: 48 }));
  });

  it("leaves the caller's password bytes untouched", async () => {
    const password = utf8ToBytes("secret");
    await subtlePbkdf2("sha256", password, new Uint8Array(16), 1, 32);
    expect(password).toStrictEqual(utf8ToBytes("secret"));
  });
});

describe("basePlatform", () => {
  it("draws fresh random bytes of the requested length", () => {
    const { random } = basePlatform();
    expect(random(32)).toHaveLength(32);
    expect(random(32)).not.toStrictEqual(random(32));
  });

  it("reads the wall clock and a monotonic clock", () => {
    const { now, elapsed } = basePlatform();
    expect(Math.abs(now() - Date.now())).toBeLessThan(1000);
    const before = elapsed();
    expect(elapsed()).toBeGreaterThanOrEqual(before);
  });

  it("runs a timer once and cancels one that has not fired", async () => {
    vi.useFakeTimers();
    const { setTimer } = basePlatform();
    const fired = vi.fn<() => void>();
    const cancelled = vi.fn<() => void>();
    setTimer(10, fired);
    setTimer(10, cancelled)();
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("offers no keystore or native passkey on the Web", () => {
    expect(basePlatform()).toMatchObject({ keystore: undefined, passkey: undefined });
  });
});

describe("loadSparkBackend", () => {
  it("instantiates the shipped spark.wasm", async () => {
    const backend = await loadSparkBackend(readSparkWasm);
    expect(backend).toBeTypeOf("object");
  });

  it("refuses bytes that are not the pinned build", async () => {
    const shipped = await readSparkWasm();
    const tampered = new Uint8Array(shipped.length + 1);
    tampered.set(shipped);
    await expect(loadSparkBackend(async () => Promise.resolve(tampered))).rejects.toMatchObject({
      code: "integrity",
    });
  });
});

describe("startNodeKernel", () => {
  it("refuses to run outside a worker or with malformed workerData", () => {
    const { port1, port2 } = new MessageChannel();
    expect(() => {
      startNodeKernel(undefined, { idleMinutes: 15, storePort: port2 }, readSparkWasm);
    }).toThrow("must run inside a worker_threads Worker");
    expect(() => {
      startNodeKernel(port1, { idleMinutes: 7, storePort: port2 }, readSparkWasm);
    }).toThrow("invalid workerData");
    port1.close();
    port2.close();
  });

  it("serves the protocol over the parent port and the vault over the store port", async () => {
    const main = new MessageChannel();
    const storeChannel = new MessageChannel();
    const stopStore = serveStore(createMemoryStore(), storeChannel.port1);
    startNodeKernel(main.port2, { idleMinutes: 15, storePort: storeChannel.port2 }, readSparkWasm);
    const replies: unknown[] = [];
    main.port1.on("message", (message: unknown) => {
      replies.push(message);
    });
    main.port1.postMessage({ v: 3, id: 1, method: "status", params: null });
    await vi.waitFor(() => {
      expect(replies).toContainEqual(
        expect.objectContaining({ id: 1, ok: expect.objectContaining({ vault: "uninitialized" }) }),
      );
    });
    stopStore();
    main.port1.close();
    main.port2.close();
    storeChannel.port1.close();
    storeChannel.port2.close();
  });
});
