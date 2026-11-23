/**
 * Google Drive CloudStore over the v3 REST API, confined to `appDataFolder` — shared by the web
 * host (a GIS token client feeding `token`) and Android (`HybridGoogleDriveAuth`). Drive holds
 * ciphertext only; the token scope cannot touch user files.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { SetTimer } from "../timer.ts";
import { timeoutSignal } from "../timer.ts";
import { checkCloudName, checkCloudText, CloudStoreError } from "./port.ts";
import type { CloudStore } from "./port.ts";

export type GoogleDriveCloudStoreOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly setTimer: SetTimer;
  /**
   * A current `drive.appdata` access token; throws CloudStoreError("auth-required") without
   * consent.
   */
  readonly token: () => Promise<string>;
  /** Drops a token Drive rejected with 401 so the next `token()` mints a fresh one. */
  readonly invalidateToken: (token: string) => Promise<void>;
};

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const REQUEST_TIMEOUT_MS = 120_000;
const LIST_PAGE_SIZE = 1000;

const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  "userRateLimitExceeded",
  "rateLimitExceeded",
  "dailyLimitExceeded",
]);

/** A Drive `files` row parsed from a list or query response. */
type DriveFile = { readonly id: string; readonly name?: string };

const isDriveFile = (value: unknown): value is DriveFile =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  (!("name" in value) || value.name === undefined || typeof value.name === "string");

type DriveFilesPage = {
  readonly files: ReadonlyArray<DriveFile>;
  readonly nextPageToken?: string;
};

const isDriveFilesPage = (value: unknown): value is DriveFilesPage =>
  typeof value === "object" &&
  value !== null &&
  "files" in value &&
  Array.isArray(value.files) &&
  value.files.every(isDriveFile) &&
  (!("nextPageToken" in value) ||
    value.nextPageToken === undefined ||
    typeof value.nextPageToken === "string");

const isCreatedFile = (value: unknown): value is { id: string } =>
  typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";

/** The `reason` of a Drive error body, or undefined when the shape is not a Drive error. */
const errorReason = async (response: Response): Promise<string | undefined> => {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("error" in body)) {
      return undefined;
    }
    const { error } = body;
    if (typeof error !== "object" || error === null || !("errors" in error)) {
      return undefined;
    }
    const { errors } = error;
    if (!Array.isArray(errors)) {
      return undefined;
    }
    const first: unknown = errors[0];
    if (typeof first !== "object" || first === null || !("reason" in first)) {
      return undefined;
    }
    return typeof first.reason === "string" ? first.reason : undefined;
  } catch {
    return undefined;
  }
};

/** A JSON body that must satisfy `guard`; anything else is a `failed` response. */
const jsonOf = async <T>(response: Response, guard: (value: unknown) => value is T): Promise<T> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudStoreError("failed", "drive returned a non-JSON response");
  }
  if (!guard(body)) {
    throw new CloudStoreError("failed", "drive returned an unexpected response shape");
  }
  return body;
};

/** Maps a non-2xx response to the typed fault; `ok` returns the response for use. */
const expectOk = async (response: Response): Promise<Response> => {
  if (response.status >= 200 && response.status < 300) {
    return response;
  }
  if (response.status === 403) {
    const reason = await errorReason(response);
    if (reason === "storageQuotaExceeded") {
      throw new CloudStoreError("quota", "drive storage quota exceeded");
    }
    if (reason === "insufficientPermissions") {
      throw new CloudStoreError("auth-required", "drive token lacks appDataFolder scope");
    }
    if (reason !== undefined && RATE_LIMIT_REASONS.has(reason)) {
      throw new CloudStoreError("unavailable", "drive rate limit exceeded");
    }
    throw new CloudStoreError("failed", `drive rejected the request (${response.status})`);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new CloudStoreError("unavailable", `drive is unavailable (${response.status})`);
  }
  throw new CloudStoreError("failed", `drive rejected the request (${response.status})`);
};

const filesUrl = (params: Record<string, string>): string => {
  const url = new URL(FILES);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

export function createGoogleDriveCloudStore({
  fetch: doFetch,
  setTimer,
  token,
  invalidateToken,
}: GoogleDriveCloudStoreOptions): CloudStore {
  /** Name → Drive file ids; lookups and writes keep it warm, reads and deletes correct it. */
  const idsByName = new Map<string, ReadonlyArray<string>>();

  /** `token()` failures that are not already typed map to unavailable (auth/consent failures are). */
  const freshToken = async (): Promise<string> => {
    try {
      return await token();
    } catch (error) {
      if (error instanceof CloudStoreError) {
        throw error;
      }
      throw new CloudStoreError("unavailable", "drive access token request failed");
    }
  };

  /** One HTTP call under the request timeout; transport failures are `unavailable`. */
  const call = async (
    url: string,
    init: { method: string; token: string; contentType?: string; body?: string },
  ): Promise<Response> => {
    const timeout = timeoutSignal(REQUEST_TIMEOUT_MS, setTimer);
    try {
      return await doFetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${init.token}`,
          ...(init.contentType === undefined ? {} : { "content-type": init.contentType }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: timeout.signal,
      });
    } catch {
      throw new CloudStoreError("unavailable", "drive request failed");
    } finally {
      timeout.cancel();
    }
  };

  /** Sends one request, retrying once with a fresh token after a 401. */
  const send = async (
    url: string,
    init: { method: string; contentType?: string; body?: string },
    retry = true,
  ): Promise<Response> => {
    const used = await freshToken();
    const response = await call(url, { ...init, token: used });
    if (response.status !== 401) {
      return response;
    }
    if (!retry) {
      throw new CloudStoreError("auth-required", "drive rejected the access token");
    }
    try {
      await invalidateToken(used);
    } catch (error) {
      if (error instanceof CloudStoreError) {
        throw error;
      }
      throw new CloudStoreError("failed", "invalidating a rejected drive token failed");
    }
    return send(url, init, false);
  };
  /** The ids behind `name`; cached when `fresh` is not requested. */
  const idsOf = async (name: string, fresh = false): Promise<ReadonlyArray<string>> => {
    const cached = idsByName.get(name);
    if (cached !== undefined && !fresh) {
      return cached;
    }
    const url = filesUrl({
      q: `name = '${name}'`,
      spaces: "appDataFolder",
      fields: "files(id)",
    });
    const page = await jsonOf(await expectOk(await send(url, { method: "GET" })), isDriveFilesPage);
    const ids = page.files.map((f) => f.id);
    idsByName.set(name, ids);
    return ids;
  };

  const deleteId = async (id: string): Promise<void> => {
    const response = await send(`${FILES}/${id}`, { method: "DELETE" });
    if (response.status === 404) {
      return;
    }
    await expectOk(response);
  };

  /** One `files` list page; `pageToken` continues the previous page. */
  const listPage = async (pageToken?: string): Promise<DriveFilesPage> => {
    const url = filesUrl({
      spaces: "appDataFolder",
      pageSize: String(LIST_PAGE_SIZE),
      fields: "nextPageToken,files(id,name)",
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    return jsonOf(await expectOk(await send(url, { method: "GET" })), isDriveFilesPage);
  };

  return {
    list: async () => {
      const names: string[] = [];
      const seen = new Set<string>();
      let page = await listPage();
      for (;;) {
        for (const file of page.files) {
          if (file.name !== undefined && !seen.has(file.name)) {
            seen.add(file.name);
            names.push(file.name);
          }
        }
        if (page.nextPageToken === undefined) {
          return names;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- each page yields the next pageToken
        page = await listPage(page.nextPageToken);
      }
    },

    read: async (name) => {
      checkCloudName(name);
      const cached = idsByName.has(name);
      let [id] = await idsOf(name);
      if (id === undefined) {
        return undefined;
      }
      let response = await send(`${FILES}/${id}?alt=media`, { method: "GET" });
      if (response.status === 404) {
        if (!cached) {
          // A fresh lookup 404 means the file vanished between query and read.
          return undefined;
        }
        // The cached id went stale: drop it, re-query once, and read the result if still there.
        idsByName.delete(name);
        [id] = await idsOf(name, true);
        if (id === undefined) {
          return undefined;
        }
        response = await send(`${FILES}/${id}?alt=media`, { method: "GET" });
        if (response.status === 404) {
          return undefined;
        }
      }
      await expectOk(response);
      return response.text();
    },

    write: async (name, text) => {
      checkCloudName(name);
      checkCloudText(text);
      const [first, ...extras] = await idsOf(name);
      if (first === undefined) {
        // One multipart request keeps create atomic — the file never exists without its content.
        const boundary = `qntx-${bytesToHex(sha256(utf8ToBytes(text))).slice(0, 48)}`;
        const metadata = JSON.stringify({ name, parents: ["appDataFolder"] });
        const body = [
          `--${boundary}`,
          "Content-Type: application/json; charset=UTF-8",
          "",
          metadata,
          `--${boundary}`,
          "Content-Type: text/plain; charset=UTF-8",
          "",
          text,
          `--${boundary}--`,
          "",
        ].join("\r\n");
        const created = await jsonOf(
          await expectOk(
            await send(`${UPLOAD}?uploadType=multipart`, {
              method: "POST",
              contentType: `multipart/related; boundary=${boundary}`,
              body,
            }),
          ),
          isCreatedFile,
        );
        idsByName.set(name, [created.id]);
        return;
      }
      const updated = await jsonOf(
        await expectOk(
          await send(`${UPLOAD}/${first}?uploadType=media`, {
            method: "PATCH",
            contentType: "text/plain; charset=UTF-8",
            body: text,
          }),
        ),
        isCreatedFile,
      );
      // Duplicate same-name files collapse onto the id Drive kept.
      await Promise.all(extras.map(deleteId));
      idsByName.set(name, [updated.id]);
    },

    delete: async (name) => {
      checkCloudName(name);
      // A fresh lookup: a stale cache could miss ids another instance created.
      const ids = await idsOf(name, true);
      await Promise.all(ids.map(deleteId));
      idsByName.delete(name);
    },
  };
}
