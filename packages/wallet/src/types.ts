/** Public types of @qntx/wallet, per design/entry.mdx. Secret data never appears here. */
export type LockReason =
  | "cold-start"
  | "user"
  | "idle"
  | "background"
  | "expired"
  | "crashed"
  | "invalidated";

export type FactorInfo =
  | { readonly kind: "hardware"; readonly id: string; readonly createdAt: number }
  | {
      readonly kind: "passkey";
      readonly id: string;
      /** Base64url, public data — the main side passes it as allowCredentials. */
      readonly credentialId: string;
      readonly createdAt: number;
    }
  | { readonly kind: "password"; readonly id: string; readonly createdAt: number };

export type WalletInfo = {
  readonly walletId: string;
  readonly origin: "passkey" | "mnemonic";
  readonly words: 12 | 15 | 18 | 21 | 24;
  /**
   * Mnemonic: the user holds the phrase (passed the writing-down quiz, imported it, or exported at
   * least once). passkey: protected only by a synced passkey — still lost when the password manager
   * or account is lost, so the UI should prompt to export. none: exists only on this device (a
   * device-bound passkey).
   */
  readonly backup: "none" | "passkey" | "mnemonic";
  /** The wallet derives from its mnemonic plus a BIP-39 passphrase; only mnemonic wallets can. */
  readonly passphrase: boolean;
  readonly createdAt: number;
};

export type NostrKeyRef = {
  readonly kind: "derived";
  readonly walletId: string;
  readonly index: number;
};

export type NostrKeyInfo = {
  readonly ref: NostrKeyRef;
  readonly publicKey: string; // 64 lowercase hex
  readonly createdAt: number;
};

/** One entry of a `nostr.discover` result: the public key an identity index produces. */
export type DerivedNostrKey = { readonly index: number; readonly publicKey: string };

export type WalletErrorCode =
  | "locked"
  | "cancelled"
  | "factor-invalidated"
  | "no-device-credential"
  | "passkey-not-configured"
  | "passkey-prf-unsupported"
  | "wrong-password"
  | "wrong-passkey"
  | "rate-limited"
  | "invalid-input"
  | "not-found"
  | "already-exists"
  | "conflict"
  | "unsupported"
  | "unavailable"
  | "integrity"
  | "approval-required"
  | "crashed";

/**
 * The vault half of the status payload: `corrupted` means authentication or structural data failed
 * to verify, `unsupported` means a newer build wrote it (data untouched, update the app),
 * `unavailable` means a transient store I/O failure (retried on the next request or change).
 */
export type VaultState =
  | "uninitialized"
  | "locked"
  | "unlocked"
  | "corrupted"
  | "unsupported"
  | "unavailable";

/**
 * `status` result / status event payload. Locked snapshots come from unauthenticated headers;
 * "corrupted" means the vault data itself failed to load or verify (reset is the only way out).
 * Each protocol module contributes one section (here: `nostr`).
 */
export type StatusPayload = {
  readonly protocol: 2; // PROTOCOL_VERSION — literal to keep types.ts import-free
  readonly vault: VaultState;
  readonly factors: ReadonlyArray<FactorInfo>;
  readonly wallets: ReadonlyArray<WalletInfo>;
  readonly nostr: { readonly keys: ReadonlyArray<NostrKeyInfo> };
  readonly importedKeys: ReadonlyArray<KeyInfo>;
  // oxlint-disable-next-line typescript/no-restricted-types -- wire contract: backup is null when off
  readonly backup: BackupInfo | null;
};

/** Public summary of a retained backup key — factors are the unwrap paths, never secrets. */
export type BackupInfo = {
  readonly id: string; // 32 lowercase hex, derived from the BEK
  readonly factors: ReadonlyArray<"passkey" | "password">;
  readonly createdAt: number;
};

/** One error class for the whole API; `code` carries the distinction. Messages never echo input. */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly retryAt: number | undefined;
  /**
   * A platform diagnostic as `"<domain>:<code>"` (e.g. `"LAErrorDomain:-5"`,
   * `"android:KeyPermanentlyInvalidatedException"`): never userInfo, localized text or input.
   */
  readonly detail: string | undefined;

  constructor(code: WalletErrorCode, message: string, retryAt?: number, detail?: string) {
    super(message);
    this.name = "WalletError";
    this.code = code;
    this.retryAt = retryAt;
    this.detail = detail;
  }
}

/**
 * A factor the user proves again for a guarded operation. `hardware` is the React Native factor:
 * the kernel shows the system verification prompt with text it renders itself.
 */
export type UnlockFactor =
  | { readonly kind: "hardware" }
  | { readonly kind: "passkey" }
  | { readonly kind: "password"; readonly password: string };

/**
 * A factor being created; `hardware` exists only on React Native. `name` is the passkey
 * credential's display name — the host validates it before the ceremony (1–64 characters).
 */
export type InitialFactor =
  | { readonly kind: "hardware" }
  | { readonly kind: "passkey"; readonly name: string }
  | { readonly kind: "password"; readonly password: string };

/**
 * WebAuthn RP identity + PRF salt labels the host configures once. `rpId`, `walletSalt` and
 * `vaultSalt` are permanent identifiers: changing any of them makes every existing passkey factor
 * and passkey-derived wallet unrecoverable, and the two salts must differ. Moving a wallet to a
 * different domain requires WebAuthn related origins (`/.well-known/webauthn`); hosts should offer
 * `exportMnemonic` for passkey-derived wallets so they survive an RP migration.
 */
export type PasskeyConfig = {
  /** RP id — the origin's effective domain or a registrable parent of it (e.g. meowl.social). */
  readonly rpId: string;
  readonly rpName: string;
  readonly walletSalt: string;
  readonly vaultSalt: string;
  /** PRF salt for the cloud-backup factor — a third, distinct permanent label. */
  readonly backupSalt: string;
};

export type AutoLockPolicy =
  | { readonly platform: "native"; readonly backgroundSeconds: 0 | 60 | 300 | 900 }
  | { readonly platform: "web"; readonly idleMinutes: 5 | 15 | 60 };

/** Public info for an imported private key — the record id, family and address. */
export type KeyInfo = {
  readonly keyId: string;
  readonly family: "evm" | "solana" | "bitcoin";
  readonly address: string;
  readonly createdAt: number;
};

/** The `wallet.keys` facade — import/list/remove/export for single private keys. */
export type KeysApi = {
  /**
   * `secret` is the family's canonical encoding: `0x`-prefixed 64-hex or 32 bytes for EVM; base58
   * or raw bytes for a Solana 32-byte seed or 64-byte keypair.
   */
  readonly import: (
    family: "evm" | "solana" | "bitcoin",
    secret: string | Uint8Array,
  ) => Promise<KeyInfo>;
  readonly list: () => Promise<ReadonlyArray<KeyInfo>>;
  readonly remove: (keyId: string, verify: UnlockFactor) => Promise<void>;
  readonly export: (keyId: string, verify: UnlockFactor) => Promise<Uint8Array>;
};

export type WalletSnapshot = {
  readonly vault: VaultState;
  readonly lockReason: LockReason | undefined;
  readonly verifying: boolean; // a user verification is in flight
  readonly factors: ReadonlyArray<FactorInfo>;
  readonly wallets: ReadonlyArray<WalletInfo>;
  readonly nostr: { readonly keys: ReadonlyArray<NostrKeyInfo> };
  readonly importedKeys: ReadonlyArray<KeyInfo>;
  /** The retained backup key's public id, or null when cloud backup is off. */
  // oxlint-disable-next-line typescript/no-restricted-types -- wire contract: backup is null when off
  readonly backup: BackupInfo | null;
};

/** A one-shot secret buffer: `read` detaches the bytes to the caller, `wipe` zeroes them. */
export type ExportedSecret = {
  readonly read: () => Uint8Array; // UTF-8 text; single use — the second call throws
  readonly wipe: () => void;
};

/** What `exportMnemonic` returns: the phrase, and the BIP-39 passphrase when the wallet has one. */
export type ExportedMnemonic = {
  readonly mnemonic: ExportedSecret;
  readonly passphrase?: ExportedSecret;
};

export type MnemonicDraft = {
  readonly words: ExportedSecret; // read once, then the host is responsible for wiping
  readonly quiz: ReadonlyArray<number>; // three positions the enclave picked
  /** `passphrase` becomes the wallet's BIP-39 passphrase; omit or pass "" for none. */
  readonly confirm: (
    answers: ReadonlyArray<string>,
    options?: { readonly passphrase?: string },
  ) => Promise<WalletInfo>;
  readonly discard: () => Promise<void>;
};

export type VaultApi = {
  readonly unlock: (factor?: UnlockFactor) => Promise<void>;
  readonly lock: () => Promise<void>;
  readonly addFactor: (factor: InitialFactor, verify: UnlockFactor) => Promise<FactorInfo>;
  readonly removeFactor: (id: string, verify: UnlockFactor) => Promise<void>; // ≥1 factor remains
  readonly reset: () => Promise<void>;
};

export type WalletsApi = {
  readonly createWithPasskey: (options: {
    /** Display name for the new passkey credential (1–64 characters after trimming). */
    readonly name: string;
    readonly factor?: InitialFactor;
  }) => Promise<WalletInfo>;
  readonly restoreWithPasskey: (options?: {
    readonly factor?: InitialFactor;
  }) => Promise<WalletInfo>;
  readonly createMnemonic: (options: {
    readonly words: 12 | 24;
    readonly factor?: InitialFactor;
  }) => Promise<MnemonicDraft>;
  readonly importMnemonic: (options: {
    readonly mnemonic: string;
    /** BIP-39 passphrase; omit or pass "" for none. Spaces are significant. */
    readonly passphrase?: string;
    readonly factor?: InitialFactor;
  }) => Promise<WalletInfo>;
  /** One-shot mnemonic (and passphrase) export; requires re-verification every call. */
  readonly exportMnemonic: (walletId: string, verify: UnlockFactor) => Promise<ExportedMnemonic>;
  readonly delete: (walletId: string, verify: UnlockFactor) => Promise<void>;
};

export type DataKeyApi = {
  readonly get: (purpose: string) => Promise<Uint8Array>;
};

/**
 * Cloud-backup entry points. `enable` re-verifies and retains a fresh BEK in the vault; `update`
 * rewrites the sealed envelope JSON with the retained BEK (no factor ceremony, so an auto-sync can
 * run silently); `restore` merges an envelope into the vault. Factor inputs reuse `UnlockFactor` —
 * passkey assertions evaluate the PRF over `backupSalt`.
 */
export type BackupApi = {
  readonly enable: (options: {
    readonly verify: UnlockFactor;
    readonly factors: ReadonlyArray<UnlockFactor>;
  }) => Promise<void>;
  readonly update: () => Promise<string>;
  readonly disable: () => Promise<void>;
  /**
   * Wallets whose header is flagged `passphrase` restore only when `passphrases` carries theirs;
   * the rest are listed in `passphraseRequired` and a later restore can bring them in.
   */
  readonly restore: (options: {
    readonly envelope: string;
    readonly backupFactor: UnlockFactor;
    readonly passphrases?: ReadonlyArray<{
      readonly walletId: string;
      readonly passphrase: string;
    }>;
    readonly factor?: InitialFactor;
  }) => Promise<{
    readonly wallets: ReadonlyArray<WalletInfo>;
    readonly passphraseRequired: ReadonlyArray<string>;
  }>;
};

export type Wallet = {
  readonly getSnapshot: () => WalletSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly vault: VaultApi;
  readonly wallets: WalletsApi;
  readonly keys: KeysApi;
  readonly dataKeys: DataKeyApi;
  readonly backup: BackupApi;
  readonly destroy: () => Promise<void>;
};
