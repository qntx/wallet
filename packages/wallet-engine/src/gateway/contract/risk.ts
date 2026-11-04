import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

export const PHISHING_HASH_BYTES = 8;
export const PHISHING_MAX_PATH_SEGMENTS = 8;

const MAX_HOST_LENGTH = 253;
const MIN_HOST_LABELS = 2;
const FORBIDDEN_ENTRY = /:\/\/|[?#@\\\s]/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Lowercase ASCII labels ending in a non-numeric label: `new URL` returns such a host unchanged. */
const PLAIN_HOST = /^(?:[a-z0-9_-]+\.)+[a-z][a-z0-9_-]*\.?$/;

const trimTrailingDot = (host: string): string => (host.endsWith(".") ? host.slice(0, -1) : host);

const pathSegments = (pathname: string): ReadonlyArray<string> =>
  pathname.split("/").filter((segment) => segment !== "");

/** One list entry as its lookup key, or `undefined` when the entry is not a usable host or path. */
export function phishingKey(entry: string): string | undefined {
  if (PLAIN_HOST.test(entry) && !entry.includes("xn--")) {
    const host = trimTrailingDot(entry);
    return host.length > MAX_HOST_LENGTH ? undefined : host;
  }
  let raw = entry.trim();
  if (raw.startsWith("*.")) {
    raw = raw.slice(2);
  }
  if (raw === "" || FORBIDDEN_ENTRY.test(raw)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    return undefined;
  }
  if ((raw.split("/")[0] ?? "").includes(":")) {
    return undefined;
  }
  const host = trimTrailingDot(url.hostname.toLowerCase());
  const labels = host.split(".");
  if (
    host.length > MAX_HOST_LENGTH ||
    labels.length < MIN_HOST_LABELS ||
    labels.some((label) => label === "")
  ) {
    return undefined;
  }
  const segments = pathSegments(url.pathname);
  if (segments.length === 0) {
    return host;
  }
  if (segments.length > PHISHING_MAX_PATH_SEGMENTS) {
    return undefined;
  }
  return `${host}/${segments.join("/")}`;
}

/** The first 8 bytes of SHA-256 over the UTF-8 key. */
export function phishingHash(key: string): Uint8Array {
  return sha256(utf8ToBytes(key)).slice(0, PHISHING_HASH_BYTES);
}

/** Lookup keys for a page URL, most specific first; empty for anything but http(s). */
export function phishingCandidates(url: string): ReadonlyArray<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return [];
  }
  const host = trimTrailingDot(parsed.hostname);
  if (host === "") {
    return [];
  }
  if (host.startsWith("[") || IPV4.test(host)) {
    return [host];
  }
  const segments = pathSegments(parsed.pathname).slice(0, PHISHING_MAX_PATH_SEGMENTS);
  const candidates: string[] = [];
  for (let depth = segments.length; depth > 0; depth -= 1) {
    candidates.push(`${host}/${segments.slice(0, depth).join("/")}`);
  }
  const labels = host.split(".");
  for (let start = 0; labels.length - start >= MIN_HOST_LABELS; start += 1) {
    candidates.push(labels.slice(start).join("."));
  }
  return candidates;
}

const version = z.number().check(z.int(), z.nonnegative());

/** Concatenated sorted 8-byte hashes, standard-alphabet base64; the empty string is an empty set. */
const hashes = z
  .string()
  .check(z.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/));

const delta = z.object({ add: hashes, remove: hashes });

export const phishingListRequest = z.object({
  since: z.optional(z.string().check(z.regex(/^\d{1,15}$/))),
});

export const phishingListResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current"), version }),
  z.object({
    kind: z.literal("diff"),
    from: version,
    version,
    deny: delta,
    allow: delta,
  }),
  z.object({ kind: z.literal("snapshot"), version, deny: hashes, allow: hashes }),
]);

export type PhishingListResponse = z.infer<typeof phishingListResponse>;

export const phishingList = endpoint(
  "GET",
  "/v1/risk/lists/phishing",
  phishingListRequest,
  phishingListResponse,
);

export const phishingListPath: string = phishingList.path;
