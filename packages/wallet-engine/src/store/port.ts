/**
 * Engine storage port: named collections of byte values. `collection` is synchronous and cheap —
 * the same collection object backs every call, so guards (closed) live on the store.
 */
export type EngineCollection = {
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  readonly put: (key: string, bytes: Uint8Array) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  /** Every key in the collection, in an unspecified order. */
  readonly list: () => Promise<ReadonlyArray<string>>;
};

export type EngineStore = {
  readonly collection: (name: string) => EngineCollection;
  readonly close: () => Promise<void>;
};

/**
 * Non-secret device data (the phishing list, the origins the user trusts): available while the
 * wallet is locked, and the host may keep it unencrypted. Never put anything secret in it.
 */
export type PublicStore = {
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  readonly put: (key: string, bytes: Uint8Array) => Promise<void>;
};

export { EngineStoreError } from "../errors.ts";
