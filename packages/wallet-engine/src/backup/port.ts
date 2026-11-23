/**
 * Cloud-file storage port (design/backup.mdx "存储"): the cloud is an opaque key-value namespace —
 * names are file names (`qntx-wallet-backup-<id>-<digest>.json`), contents are envelope texts. The
 * kernel never sees it; only the engine transports ciphertext across it.
 *
 * Semantics every implementation honours:
 *
 * - S1 names matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/ only — ≤ 255 chars, CloudKit's recordName
 *   limit; violations reject `invalid` before any I/O (the rule keeps Drive's `name = '…'` query
 *   escape-free).
 * - S2 texts hold at most CLOUD_TEXT_MAX_BYTES UTF-8 bytes with no lone surrogate; non-ASCII
 *   round-trips byte-exact.
 * - S3 a write lands atomically: a read sees the old text or the new text, never a prefix.
 * - S4 a read returns the complete text or undefined; truncation surfaces as an error.
 * - S5 a write is readable by the same instance immediately (read-your-own-write).
 * - S6 list pages fully and dedupes; it is eventually consistent but never invents names.
 * - S7 deleting a missing name succeeds; a deleted name reads undefined.
 * - S8 same-name concurrent writes converge to one of the texts, listed exactly once.
 * - S9 every failure is a CloudStoreError carrying a CloudStoreErrorCode.
 */
export type CloudStore = {
  /** Every file name in the namespace. */
  readonly list: () => Promise<ReadonlyArray<string>>;
  /** File contents, or undefined when the name does not exist. */
  readonly read: (name: string) => Promise<string | undefined>;
  /** Overwrites the whole file atomically from the caller's perspective. */
  readonly write: (name: string, text: string) => Promise<void>;
  /** Deleting a missing file succeeds. */
  readonly delete: (name: string) => Promise<void>;
};

export type CloudStoreErrorCode = "unavailable" | "auth-required" | "quota" | "invalid" | "failed";

export class CloudStoreError extends Error {
  readonly code: CloudStoreErrorCode;

  constructor(code: CloudStoreErrorCode, message: string) {
    super(message);
    this.name = "CloudStoreError";
    this.code = code;
  }
}

export const CLOUD_TEXT_MAX_BYTES = 4_000_000;

const CLOUD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const LONE_SURROGATE = /\p{Cs}/u;

export function checkCloudName(name: string): void {
  if (!CLOUD_NAME_PATTERN.test(name)) {
    throw new CloudStoreError("invalid", "cloud file name is not a valid portable name");
  }
}

export function checkCloudText(text: string): void {
  if (LONE_SURROGATE.test(text)) {
    throw new CloudStoreError("invalid", "cloud file text contains a lone surrogate");
  }
  if (new TextEncoder().encode(text).byteLength > CLOUD_TEXT_MAX_BYTES) {
    throw new CloudStoreError("invalid", "cloud file text exceeds the byte limit");
  }
}
