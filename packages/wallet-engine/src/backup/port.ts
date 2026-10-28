/**
 * Cloud-file storage port (design/backup.mdx "存储"): the cloud is an opaque key-value namespace —
 * names are file names (`qntx-wallet-backup-<id>.json`), contents are envelope texts. The kernel
 * never sees it; only the engine transports ciphertext across it.
 */
export type CloudStore = {
  /** Cloud account usable and the drive reachable. */
  readonly available: () => Promise<boolean>;
  /** Every file name in the namespace. */
  readonly list: () => Promise<ReadonlyArray<string>>;
  /** File contents, or undefined when the name does not exist. */
  readonly read: (name: string) => Promise<string | undefined>;
  /** Overwrites the whole file atomically from the caller's perspective. */
  readonly write: (name: string, text: string) => Promise<void>;
  /** Deleting a missing file succeeds. */
  readonly delete: (name: string) => Promise<void>;
};
