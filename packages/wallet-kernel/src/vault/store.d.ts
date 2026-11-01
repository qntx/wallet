/** Whether `kind` is a well-formed record kind (lowercase, 1–32 characters). */
export declare function isRecordKind(kind: string): boolean;
/** On-disk vault shapes. `header` is the raw JSON text, authenticated as-is. */
export type StoredRecord = {
    readonly kind: string;
    readonly id: string;
    readonly header: string;
    readonly sealed: Uint8Array;
};
export type StoredFactor = {
    readonly kind: string;
    readonly id: string;
    readonly header: string;
    readonly sealed: Uint8Array;
};
/** The vault format this build reads and writes. Anything else is `unsupported`. */
export declare const VAULT_FORMAT = 2;
export type VaultMeta = {
    readonly format: number;
    readonly revision: number;
    readonly keyId: string;
    readonly failedAttempts: number;
    readonly lastFailureAt: number;
};
export type VaultImage = {
    readonly meta: VaultMeta | undefined;
    readonly records: ReadonlyArray<StoredRecord>;
    readonly factors: ReadonlyArray<StoredFactor>;
};
export type StoreOp = {
    readonly op: "init";
    readonly meta: VaultMeta;
} | {
    readonly op: "expect-revision";
    readonly revision: number;
} | {
    readonly op: "set-key-id";
    readonly keyId: string;
} | {
    readonly op: "record-failure";
    readonly at: number;
} | {
    readonly op: "reset-failures";
} | {
    readonly op: "put-record";
    readonly record: StoredRecord;
} | {
    readonly op: "delete-record";
    readonly kind: string;
    readonly id: string;
} | {
    readonly op: "put-factor";
    readonly factor: StoredFactor;
} | {
    readonly op: "delete-factor";
    readonly id: string;
} | {
    readonly op: "clear";
};
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
