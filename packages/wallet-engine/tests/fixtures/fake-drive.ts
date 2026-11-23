/**
 * HTTP-level fake of the Google Drive v3 endpoints the CloudStore adapter uses. Files live in an
 * insertion-ordered map keyed by id; every request is logged verbatim (method, URL, headers, body)
 * so tests can assert exact URLs and multipart bytes. `fail` queues provider faults per op;
 * `revoke` makes a Bearer token 401 until unrevoked; `pageSize` forces list paging.
 */

export type FakeDriveRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body?: string;
};

export type FakeDriveFile = {
  readonly id: string;
  name: string;
  text: string;
};

export type FakeDriveOp = "list" | "read" | "write" | "delete";
export type FakeDriveFault = "unavailable" | "auth-required" | "quota";

export type FakeDrive = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: ReadonlyArray<FakeDriveRequest>;
  readonly files: Map<string, FakeDriveFile>;
  /** List pages hold at most this many rows regardless of the requested pageSize. */
  pageSize: number;
  /** Arms the next request(s) the op issues to fail with this provider fault. */
  readonly fail: (op: FakeDriveOp, kind: FakeDriveFault) => void;
  /** Makes `token` 401 (token revoked/expired) until `unrevoke`. */
  readonly revoke: (token: string) => void;
  readonly unrevoke: (token: string) => void;
  /** Drops the request log — tests reset it between phases. */
  readonly resetLog: () => void;
};

type RequestKind = "query" | "read" | "write" | "delete";

/** Which HTTP request kinds each CloudStore op may issue first (writes and reads look up ids). */
const OP_REQUEST_KINDS: Record<FakeDriveOp, ReadonlyArray<RequestKind>> = {
  list: ["query"],
  read: ["query", "read"],
  write: ["query", "write"],
  delete: ["query", "delete"],
};

const driveError = (status: number, reason: string, message: string): Response =>
  Response.json(
    {
      error: {
        code: status,
        message,
        errors: [{ domain: "global", reason, message }],
      },
    },
    { status, headers: { "content-type": "application/json; charset=UTF-8" } },
  );

const jsonOk = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });

const classify = (url: URL, method: string): RequestKind | undefined => {
  if (method === "GET" && url.pathname === "/drive/v3/files") {
    return "query";
  }
  if (
    method === "GET" &&
    url.pathname.startsWith("/drive/v3/files/") &&
    url.searchParams.get("alt") === "media"
  ) {
    return "read";
  }
  if (
    (method === "POST" && url.pathname === "/upload/drive/v3/files") ||
    (method === "PATCH" && url.pathname.startsWith("/upload/drive/v3/files/"))
  ) {
    return "write";
  }
  if (method === "DELETE" && url.pathname.startsWith("/drive/v3/files/")) {
    return "delete";
  }
  return undefined;
};

const parseMultipart = (
  contentType: string,
  body: string,
): { name: string; text: string } | undefined => {
  const boundary = /boundary=(\S+)/.exec(contentType)?.[1];
  if (boundary === undefined) {
    return undefined;
  }
  const parts = body.split(`--${boundary}`);
  let name: string | undefined;
  let text: string | undefined;
  for (const part of parts) {
    const splitAt = part.indexOf("\r\n\r\n");
    if (splitAt === -1) {
      continue;
    }
    const partType = /content-type: ([^\s;]+)/i.exec(part.slice(0, splitAt))?.[1];
    const payload = part.slice(splitAt + 4).replace(/\r\n$/, "");
    if (partType === "application/json") {
      try {
        const meta: unknown = JSON.parse(payload);
        name =
          typeof meta === "object" &&
          meta !== null &&
          "name" in meta &&
          typeof meta.name === "string"
            ? meta.name
            : undefined;
      } catch {
        return undefined;
      }
    } else if (partType === "text/plain") {
      text = payload;
    }
  }
  if (name === undefined || text === undefined) {
    return undefined;
  }
  return { name, text };
};

export function createFakeDrive(options?: { pageSize?: number }): FakeDrive {
  const files = new Map<string, FakeDriveFile>();
  const requests: FakeDriveRequest[] = [];
  const revoked = new Set<string>();
  /** Armed faults in order; each fires `shots` times on the first request of a matching kind. */
  const faults: Array<{
    kinds: ReadonlyArray<RequestKind>;
    shots: number;
    respond: () => Response;
  }> = [];
  let nextId = 1;
  let pageSize = options?.pageSize ?? 1000;

  const route = (url: URL, method: string, headers: Headers, body?: string): Response => {
    if (method === "GET" && url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q");
      const wanted = q === null ? undefined : /name = '([^']*)'/.exec(q)?.[1];
      if (q !== null && wanted === undefined) {
        return driveError(400, "invalid", "unsupported query");
      }
      const rows = [...files.values()].filter((f) => wanted === undefined || f.name === wanted);
      if (wanted !== undefined) {
        // Name lookups answer in one page with ids only.
        return jsonOk({ files: rows.map((f) => ({ id: f.id })) });
      }
      const withName = (url.searchParams.get("fields") ?? "").includes("files(id,name)");
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      const page = rows.slice(offset, offset + pageSize);
      const more = offset + pageSize < rows.length;
      return jsonOk({
        files: page.map((f) => (withName ? { id: f.id, name: f.name } : { id: f.id })),
        ...(more ? { nextPageToken: String(offset + pageSize) } : {}),
      });
    }
    if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
      if (url.searchParams.get("uploadType") !== "multipart" || body === undefined) {
        return driveError(400, "invalid", "bad upload");
      }
      const parsed = parseMultipart(headers.get("content-type") ?? "", body);
      if (parsed === undefined) {
        return driveError(400, "invalid", "malformed multipart body");
      }
      const created = { id: `file-${nextId}`, name: parsed.name, text: parsed.text };
      nextId += 1;
      files.set(created.id, created);
      return jsonOk({ id: created.id, name: created.name });
    }
    const idMatch = /^\/(?:upload\/)?drive\/v3\/files\/([^/?]+)/.exec(url.pathname);
    const fileId = idMatch?.at(1);
    if (fileId === undefined) {
      return driveError(404, "notFound", "file not found");
    }
    const file = files.get(fileId);
    if (method === "GET" && url.pathname.startsWith("/drive/v3/files/")) {
      if (url.searchParams.get("alt") !== "media" || file === undefined) {
        return driveError(404, "notFound", "file not found");
      }
      return new Response(file.text, {
        status: 200,
        headers: { "content-type": "text/plain; charset=UTF-8" },
      });
    }
    if (method === "PATCH" && url.pathname.startsWith("/upload/drive/v3/files/")) {
      if (url.searchParams.get("uploadType") !== "media" || file === undefined) {
        return driveError(404, "notFound", "file not found");
      }
      file.text = body ?? "";
      return jsonOk({ id: file.id, name: file.name });
    }
    if (method === "DELETE") {
      if (file === undefined) {
        return driveError(404, "notFound", "file not found");
      }
      files.delete(file.id);
      return new Response(null, { status: 204 });
    }
    return driveError(400, "invalid", "unsupported request");
  };

  return {
    fetch: async (input, init) => {
      // One microtask of latency keeps the fake honest — a real fetch is never synchronous.
      await Promise.resolve();
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({
        method,
        url: url.toString(),
        headers,
        ...(body === undefined ? {} : { body }),
      });

      const bearer = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
      if (bearer === undefined || revoked.has(bearer)) {
        return driveError(401, "authError", "request had invalid authentication credentials");
      }
      const kind = classify(url, method);
      const fault = kind === undefined ? undefined : faults.find((f) => f.kinds.includes(kind));
      if (fault !== undefined) {
        const response = fault.respond();
        fault.shots -= 1;
        if (fault.shots === 0) {
          faults.splice(faults.indexOf(fault), 1);
        }
        return response;
      }
      if (kind === undefined) {
        return driveError(400, "invalid", "unsupported request");
      }
      return route(url, method, headers, body);
    },
    requests,
    files,
    get pageSize() {
      return pageSize;
    },
    set pageSize(value: number) {
      pageSize = value;
    },
    fail: (op, kind) => {
      const kinds = OP_REQUEST_KINDS[op];
      if (kind === "unavailable") {
        faults.push({
          kinds,
          shots: 1,
          respond: () => driveError(503, "backendError", "backend error"),
        });
        return;
      }
      if (kind === "quota") {
        faults.push({
          kinds,
          shots: 1,
          respond: () =>
            driveError(403, "storageQuotaExceeded", "the user's storage quota is exceeded"),
        });
        return;
      }
      // auth-required: two 401s — the first request and the adapter's single retry.
      faults.push({
        kinds,
        shots: 2,
        respond: () =>
          driveError(401, "authError", "request had invalid authentication credentials"),
      });
    },
    revoke: (token) => {
      revoked.add(token);
    },
    unrevoke: (token) => {
      revoked.delete(token);
    },
    resetLog: () => {
      requests.length = 0;
    },
  };
}
