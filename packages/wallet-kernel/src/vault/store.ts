import type { UnsupportedReason } from "@qntx/wallet/types";

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
 * The only vault format this build reads and writes: format 6 authenticates the vault's structure —
 * revision included — under the DEK (vault/manifest.ts) and moves the failure counters out of the
 * image into the vault anchor (vault/anchor.ts). Any other format is `unsupported` and left
 * untouched.
 */
export const VAULT_FORMAT = 6;

/**
 * The unsupported direction of a stored vault format: `older` below VAULT_FORMAT, `newer` above.
 * The invariant that makes the comparison meaningful: pre-1.0, every removal or change of a record
 * or factor kind, a policy id or a KDF parameter bumps VAULT_FORMAT — so unknown content inside the
 * current format (a record kind no module owns, an unknown factor kind, an unknown policy id, new
 * KDF parameters) can only have come from a newer build.
 */
export function formatReason(format: number): UnsupportedReason {
  return format < VAULT_FORMAT ? "older" : "newer";
}

export type VaultMeta = {
  readonly format: number; // this build reads VAULT_FORMAT only
  readonly revision: number; // incremented once per content commit, inside the transaction
  readonly keyId: string; // 32 lowercase hex; changes on DEK rotation (public change signal)
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
