// oxlint-disable vitest/no-conditional-in-test -- request-log assertions are inherently conditional
import { describe, expect, it } from "vite-plus/test";

import { createGoogleDriveCloudStore } from "../src/backup/google-drive.ts";
import type { GoogleDriveCloudStoreOptions } from "../src/backup/google-drive.ts";
import { CLOUD_TEXT_MAX_BYTES, CloudStoreError } from "../src/backup/port.ts";
import type { SetTimer } from "../src/timer.ts";
import { describeCloudStore } from "./cloud/conformance.ts";
import { createFakeDrive } from "./fixtures/fake-drive.ts";
import type { FakeDrive, FakeDriveRequest } from "./fixtures/fake-drive.ts";

const realSetTimer: SetTimer = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const nthRequest = (drive: FakeDrive, index: number): FakeDriveRequest => {
  const request = drive.requests.at(index);
  if (request === undefined) {
    throw new Error(`expected request ${index} — the log holds ${drive.requests.length}`);
  }
  return request;
};

const rig = (
  drive: FakeDrive,
  options?: Partial<GoogleDriveCloudStoreOptions>,
): { store: ReturnType<typeof createGoogleDriveCloudStore>; invalidated: string[] } => {
  const invalidated: string[] = [];
  return {
    invalidated,
    store: createGoogleDriveCloudStore({
      fetch: drive.fetch,
      setTimer: realSetTimer,
      token: async () => Promise.resolve("tok"),
      invalidateToken: async (t) => {
        invalidated.push(t);
        drive.unrevoke(t);
        return Promise.resolve();
      },
      ...options,
    }),
  };
};

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof CloudStoreError) {
      return error.code;
    }
    throw error;
  }
  return "none";
};

const name = "doc.txt";

// The adapter runs the shared CloudStore conformance suite (S1–S9), with the fake Drive
// carrying the provider faults the port promises to map.
describeCloudStore("google-drive", () => {
  const drive = createFakeDrive({ pageSize: 3 });
  return { store: rig(drive).store, fault: drive.fail };
});

describe("google-drive requests", () => {
  it("lists every appDataFolder page and dedupes names", async () => {
    const drive = createFakeDrive({ pageSize: 2 });
    const { store } = rig(drive);
    for (const [id, fileName] of [
      ["a", "one"],
      ["b", "two"],
      ["c", "one"],
      ["d", "three"],
    ] as const) {
      drive.files.set(id, { id, name: fileName, text: "x" });
    }
    drive.resetLog();
    const names = await store.list();
    expect(names.toSorted()).toStrictEqual(["one", "three", "two"]);
    const urls = drive.requests.map((r) => new URL(r.url));
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(`${url.origin}${url.pathname}`).toBe("https://www.googleapis.com/drive/v3/files");
      expect(url.searchParams.get("spaces")).toBe("appDataFolder");
      expect(url.searchParams.get("pageSize")).toBe("1000");
      expect(url.searchParams.get("fields")).toBe("nextPageToken,files(id,name)");
    }
    expect(urls.at(0)?.searchParams.has("pageToken")).toBe(false);
    expect(urls.at(1)?.searchParams.get("pageToken")).toBe("2");
    for (const r of drive.requests) {
      expect(r.headers.get("authorization")).toBe("Bearer tok");
    }
  });

  it("creates through one multipart request with metadata and text parts", async () => {
    const drive = createFakeDrive();
    const { store } = rig(drive);
    await store.write(name, "hello ✓");
    expect(drive.requests).toHaveLength(2);
    const query = nthRequest(drive, 0);
    const create = nthRequest(drive, 1);
    const q = new URL(query.url);
    expect(q.searchParams.get("q")).toBe(`name = '${name}'`);
    expect(q.searchParams.get("spaces")).toBe("appDataFolder");
    expect(q.searchParams.get("fields")).toBe("files(id)");
    const u = new URL(create.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://www.googleapis.com/upload/drive/v3/files");
    expect(u.searchParams.get("uploadType")).toBe("multipart");
    expect(create.method).toBe("POST");
    const boundary = /multipart\/related; boundary=(\S+)/.exec(
      create.headers.get("content-type") ?? "",
    )?.[1];
    expect(boundary?.startsWith("qntx-")).toBe(true);
    expect(create.body).toBe(
      `--${boundary}\r\n` +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        `{"name":"${name}","parents":["appDataFolder"]}\r\n` +
        `--${boundary}\r\n` +
        "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
        "hello ✓\r\n" +
        `--${boundary}--\r\n`,
    );
    // The same write goes through the media PATCH the second time.
    drive.resetLog();
    await store.write(name, "v2");
    const patch = nthRequest(drive, 0);
    const p = new URL(patch.url);
    expect(p.pathname).toBe("/upload/drive/v3/files/file-1");
    expect(p.searchParams.get("uploadType")).toBe("media");
    expect(patch.method).toBe("PATCH");
    expect(patch.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(patch.body).toBe("v2");
    await expect(store.read(name)).resolves.toBe("v2");
  });

  it("converges duplicate same-name files onto the updated one", async () => {
    const drive = createFakeDrive();
    drive.files.set("f1", { id: "f1", name, text: "old" });
    drive.files.set("f2", { id: "f2", name, text: "dup" });
    const { store } = rig(drive);
    await store.write(name, "merged");
    expect([...drive.files.keys()]).toStrictEqual(["f1"]);
    expect(drive.files.get("f1")?.text).toBe("merged");
    const paths = drive.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths).toStrictEqual([
      "GET /drive/v3/files",
      "PATCH /upload/drive/v3/files/f1",
      "DELETE /drive/v3/files/f2",
    ]);
  });

  it("deletes every id behind a name and tolerates 404s", async () => {
    const drive = createFakeDrive();
    drive.files.set("f1", { id: "f1", name, text: "a" });
    drive.files.set("f2", { id: "f2", name, text: "b" });
    const { store } = rig(drive);
    await store.delete(name);
    expect(drive.files.size).toBe(0);
    await expect(codeOf(store.delete("missing.txt"))).resolves.toBe("none");
  });

  it("re-queries once after a cached id 404s on read", async () => {
    const drive = createFakeDrive();
    const { store } = rig(drive);
    await store.write(name, "v1");
    // Another instance replaced the file: the cached id is gone, a new one exists.
    drive.files.delete("file-1");
    drive.files.set("file-9", { id: "file-9", name, text: "v2" });
    drive.resetLog();
    await expect(store.read(name)).resolves.toBe("v2");
    const paths = drive.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths).toStrictEqual([
      "GET /drive/v3/files/file-1",
      "GET /drive/v3/files",
      "GET /drive/v3/files/file-9",
    ]);
    // …and a cached 404 with nothing behind the name reads undefined.
    drive.files.delete("file-9");
    drive.resetLog();
    await expect(store.read(name)).resolves.toBeUndefined();
  });

  it("validates names and texts before any request", async () => {
    const drive = createFakeDrive();
    const { store } = rig(drive);
    await expect(codeOf(store.read("bad name"))).resolves.toBe("invalid");
    await expect(codeOf(store.write("bad/name", "x"))).resolves.toBe("invalid");
    await expect(codeOf(store.delete("bad name"))).resolves.toBe("invalid");
    await expect(codeOf(store.write(name, "x".repeat(CLOUD_TEXT_MAX_BYTES + 1)))).resolves.toBe(
      "invalid",
    );
    expect(drive.requests).toHaveLength(0);
  });
});

describe("google-drive faults", () => {
  it("invalidates a 401 token, retries once, and then requires auth", async () => {
    const drive = createFakeDrive();
    drive.files.set("f1", { id: "f1", name, text: "a" });
    let tokens = 0;
    const { store, invalidated } = rig(drive, {
      token: async () => {
        tokens += 1;
        return Promise.resolve(`tok-${tokens}`);
      },
    });
    // Revoke every token: the first request 401s, the retry with the fresh token 401s again.
    drive.revoke("tok-1");
    drive.revoke("tok-2");
    await expect(codeOf(store.list())).resolves.toBe("auth-required");
    expect(invalidated).toStrictEqual(["tok-1"]);
    // Exactly two requests: the bound is one retry, never a loop.
    expect(drive.requests).toHaveLength(2);
  });

  it("succeeds on the retry when only the first token is stale", async () => {
    const drive = createFakeDrive();
    drive.files.set("f1", { id: "f1", name, text: "a" });
    let tokens = 0;
    const { store, invalidated } = rig(drive, {
      token: async () => {
        tokens += 1;
        return Promise.resolve(`tok-${tokens}`);
      },
    });
    drive.revoke("tok-1");
    await expect(store.list()).resolves.toStrictEqual([name]);
    expect(invalidated).toStrictEqual(["tok-1"]);
    expect(drive.requests).toHaveLength(2);
    expect(nthRequest(drive, 1).headers.get("authorization")).toBe("Bearer tok-2");
  });

  it("propagates a token() CloudStoreError unchanged", async () => {
    const drive = createFakeDrive();
    const error = new CloudStoreError("auth-required", "consent needed");
    const { store } = rig(drive, {
      token: async () => Promise.reject(error),
    });
    await expect(store.list()).rejects.toBe(error);
    expect(drive.requests).toHaveLength(0);
  });

  it("maps each Drive failure to the typed code", async () => {
    const cases: Array<{ status: number; reason?: string; body?: string; want: string }> = [
      { status: 403, reason: "storageQuotaExceeded", want: "quota" },
      { status: 403, reason: "insufficientPermissions", want: "auth-required" },
      { status: 403, reason: "userRateLimitExceeded", want: "unavailable" },
      { status: 403, reason: "rateLimitExceeded", want: "unavailable" },
      { status: 403, reason: "dailyLimitExceeded", want: "unavailable" },
      { status: 403, reason: "forbidden", want: "failed" },
      { status: 429, want: "unavailable" },
      { status: 500, want: "unavailable" },
      { status: 503, want: "unavailable" },
      { status: 400, want: "failed" },
      { status: 404, want: "failed" },
      { status: 200, body: "not json", want: "failed" },
      { status: 200, body: '{"files": "oops"}', want: "failed" },
    ];
    for (const c of cases) {
      const drive = createFakeDrive();
      const { store } = rig(drive, {
        fetch: async () =>
          Promise.resolve(
            new Response(c.body ?? JSON.stringify({ error: { errors: [{ reason: c.reason }] } }), {
              status: c.status,
            }),
          ),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- each case is an isolated store
      await expect(codeOf(store.list())).resolves.toBe(c.want);
    }
  });

  it("maps a thrown fetch and a request timeout to unavailable", async () => {
    const drive = createFakeDrive();
    const failing = rig(drive, {
      fetch: async () => Promise.reject(new TypeError("network down")),
    });
    await expect(codeOf(failing.store.list())).resolves.toBe("unavailable");

    const timers: Array<() => unknown> = [];
    const hanging = rig(drive, {
      setTimer: (_ms, fn) => {
        timers.push(fn);
        return () => {};
      },
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "AbortError"));
          });
        }),
    });
    const pending = hanging.store.list();
    // token() resolves first; the request timer is armed one tick later.
    await new Promise((resolve) => setTimeout(resolve));
    expect(timers).toHaveLength(1);
    timers.at(0)?.();
    await expect(codeOf(pending)).resolves.toBe("unavailable");
  });

  it("maps a truncated 2xx body to unavailable, never an untyped error", async () => {
    const drive = createFakeDrive();
    drive.files.set("f1", { id: "f1", name, text: "x" });
    const broken = () =>
      new Response(
        new ReadableStream({
          start: (controller) => {
            controller.error(new TypeError("stream reset"));
          },
        }),
        { status: 200 },
      );
    const reader = rig(drive, {
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.includes("alt=media") ? Promise.resolve(broken()) : drive.fetch(input, init);
      },
    });
    await expect(codeOf(reader.store.read(name))).resolves.toBe("unavailable");
    const lister = rig(drive, { fetch: async () => Promise.resolve(broken()) });
    await expect(codeOf(lister.store.list())).resolves.toBe("unavailable");
  });

  it("a 404 on the cached write id re-queries and creates when the name is gone", async () => {
    const drive = createFakeDrive();
    const { store } = rig(drive);
    await store.write(name, "v1");
    drive.files.clear(); // the provider lost the file; the name→id cache still holds it
    drive.resetLog();
    await store.write(name, "v2");
    expect(drive.requests).toHaveLength(3);
    expect(nthRequest(drive, 0).method).toBe("PATCH");
    expect(new URL(nthRequest(drive, 1).url).searchParams.get("q")).toBe(`name = '${name}'`);
    expect(nthRequest(drive, 2).method).toBe("POST");
    const [file] = [...drive.files.values()];
    expect(file?.text).toBe("v2");
  });

  it("a 404 on the cached write id falls back to the fresh id", async () => {
    const drive = createFakeDrive();
    const { store } = rig(drive);
    await store.write(name, "v1");
    const [oldId] = [...drive.files.keys()];
    drive.files.delete(oldId!);
    drive.files.set("fresh-id", { id: "fresh-id", name, text: "v1" });
    drive.resetLog();
    await store.write(name, "v3");
    expect(drive.requests).toHaveLength(3);
    expect(nthRequest(drive, 0).method).toBe("PATCH");
    expect(new URL(nthRequest(drive, 1).url).searchParams.get("q")).toBe(`name = '${name}'`);
    expect(nthRequest(drive, 2).method).toBe("PATCH");
    expect(nthRequest(drive, 2).url).toContain("fresh-id");
    expect(drive.files.get("fresh-id")?.text).toBe("v3");
  });

  it("a list warms the id cache — reads and writes skip the name query", async () => {
    const drive = createFakeDrive();
    drive.files.set("f1", { id: "f1", name, text: "v1" });
    const { store } = rig(drive);
    drive.resetLog();
    await store.list();
    await store.read(name);
    await store.write(name, "v2");
    expect(drive.requests.every((r) => !r.url.includes("q="))).toBe(true);
    await expect(store.read(name)).resolves.toBe("v2");
  });
});
