/**
 * A record kind names the module that owns the record's header and plaintext format. The store and
 * the envelope are kind-agnostic: any string matching the pattern is a valid kind, and a stored
 * kind no module claims marks the vault unsupported rather than being dropped.
 */
const RECORD_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Whether `kind` is a well-formed record kind (lowercase, 1–32 characters). */
export function isRecordKind(kind: string): boolean {
  return RECORD_KIND_PATTERN.test(kind);
}

/** The card module's wallet record kind — named here so the vault and commands layers know it. */
export const CARD_WALLET_KIND = "card-wallet";

/** On-disk vault shapes. `header` is the raw JSON text, authenticated as-is. */
export type StoredRecord = {
  readonly kind: string; // see isRecordKind
  readonly id: string;
  readonly header: string;
  readonly sealed: Uint8Array;
};

export type StoredFactor = {
  readonly kind: string; // see isRecordKind; unknown kinds are classified by the kernel
  readonly id: string; // hex of 16 random bytes
  readonly header: string;
  readonly sealed: Uint8Array; // wrapped DEK
};

/**
 * The only vault format this build reads and writes: format 5 authenticates the vault's structure
 * under the DEK (vault/manifest.ts). Any other format is `unsupported` and left untouched.
 */
export const VAULT_FORMAT = 5;

export type VaultMeta = {
  readonly format: number; // this build reads VAULT_FORMAT only
  readonly revision: number; // incremented once per content commit, inside the transaction
  readonly keyId: string; // 32 lowercase hex; changes on DEK rotation (public change signal)
  readonly failedAttempts: number; // consecutive password failures
  readonly lastFailureAt: number; // wall-clock ms of the last counted failure; 0 = none
};

export type VaultImage = {
  readonly meta: VaultMeta | undefined; // undefined means uninitialized
  readonly records: ReadonlyArray<StoredRecord>;
  readonly factors: ReadonlyArray<StoredFactor>;
};

export type StoreOp =
  | { readonly op: "init"; readonly meta: VaultMeta } // precondition: the store is fully empty
  | { readonly op: "expect-revision"; readonly revision: number } // precondition: meta.revision matches
  | { readonly op: "set-key-id"; readonly keyId: string }
  | { readonly op: "record-failure"; readonly at: number } // failedAttempts += 1, lastFailureAt = at
  | { readonly op: "reset-failures" } // failedAttempts = 0, lastFailureAt = 0
  | { readonly op: "put-record"; readonly record: StoredRecord }
  | { readonly op: "delete-record"; readonly kind: string; readonly id: string }
  | { readonly op: "put-factor"; readonly factor: StoredFactor }
  | { readonly op: "delete-factor"; readonly id: string }
  | { readonly op: "clear" };

export type RecordStore = {
  load: () => Promise<VaultImage>;
  /**
   * Atomic. A failed precondition rejects with `KernelError("conflict")` and writes nothing; a
   * commit containing a content op (put/delete record or factor, set-key-id) increments
   * `meta.revision` by one inside the same transaction.
   */
  commit: (ops: ReadonlyArray<StoreOp>) => Promise<void>;
  /** Fires after every commit (other tabs on Web trigger it via the host). */
  watch: (listener: () => void) => () => void;
};
