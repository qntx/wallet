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
  | { readonly kind: "device"; readonly id: string; readonly createdAt: number }
  | { readonly kind: "hardware"; readonly id: string; readonly createdAt: number }
  | {
      readonly kind: "passkey";
      readonly id: string;
      /** Base64url, public data — the main side passes it as allowCredentials. */
      readonly credentialId: string;
      readonly createdAt: number;
    }
  | { readonly kind: "password"; readonly id: string; readonly createdAt: number };

/** The hardware-signing device families the kernel knows; each signer lane adds a literal. */
export const HARDWARE_DEVICES = ["keystone", "ledger"] as const;

/** A hardware-signing device family the kernel knows; each signer adds a literal. */
export type HardwareDevice = (typeof HARDWARE_DEVICES)[number];

/** A wallet whose seed lives sealed in this vault (an `entropy` record). */
export type VaultWalletInfo = {
  readonly custody: "vault";
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

/**
 * An externally signed wallet: the vault stores the device's master fingerprint and its pinned
 * public material — never a seed — so there is no origin, word count or backup state to report.
 */
export type HardwareWalletInfo = {
  readonly custody: "hardware";
  readonly walletId: string;
  /** The paired device kind — possibly one this build does not know (see `supported`). */
  readonly device: string;
  /** Whether this build ships a driver for `device`; unknown kinds stay inert. */
  readonly supported: boolean;
  /** The device master fingerprint as 8 lowercase hex chars. */
  readonly fingerprint: string;
  readonly model?: string;
  readonly firmware?: string;
  readonly createdAt: number;
};

/**
 * A wallet whose seed lives only on qntx cards (a `card-wallet` record): the vault caches the
 * public material a tap fetched, never the seed. `members` is the card count k (1–3).
 */
export type CardWalletInfo = {
  readonly custody: "card";
  readonly walletId: string;
  readonly origin: "card-generated" | "card-imported";
  readonly backup: "cards";
  readonly createdAt: number;
  readonly members: number;
  readonly cards: ReadonlyArray<CardInfo>;
};

export type CardInfo = {
  /** `ID(A)`: 32 lowercase hex identifying the card's identity key. */
  readonly cardId: string;
  /** `XXXX-XXXX` display id — only when the record pins this card's certificate. */
  readonly shortId?: string;
  /** `pending` never finished its IMPORT; `unknown` this kernel has not checked it yet. */
  readonly state: "ready" | "unknown" | "pending";
  /** Remaining access-code tries this kernel recorded (0..10). */
  readonly tries?: number;
  readonly verifiedAt?: number;
};

export type WalletInfo = VaultWalletInfo | HardwareWalletInfo | CardWalletInfo;

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
  | "verification-unavailable"
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
  | "blind-signing-disabled"
  | "approval-required"
  | "card-not-genuine"
  | "card-id-mismatch"
  | "card-erased"
  | "card-locked"
  | "card-tampered"
  | "card-fault"
  | "card-unsupported"
  | "crashed"
  | "device-required"
  | "device-locked"
  | "device-app-closed"
  | "device-rejected"
  | "wrong-device";

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
  readonly protocol: 3; // PROTOCOL_VERSION — literal to keep types.ts import-free
  readonly vault: VaultState;
  /** Whether the vault requires a verifying unlock (established vaults without a device factor). */
  readonly appLock: boolean;
  /** Whether any factor that can prove user presence exists (hardware, passkey or password). */
  readonly verification: "available" | "unavailable";
  readonly factors: ReadonlyArray<FactorInfo>;
  readonly wallets: ReadonlyArray<WalletInfo>;
  readonly nostr: { readonly keys: ReadonlyArray<NostrKeyInfo> };
  readonly importedKeys: ReadonlyArray<KeyInfo>;
  // oxlint-disable-next-line typescript/no-restricted-types -- wire contract: backup is null when off
  readonly backup: BackupInfo | null;
  /**
   * Whether the vault signs requests the chain decoder marks blind — content it cannot show or
   * bound.
   */
  readonly blindSigning: boolean;
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
 * A factor that opens the vault. `device` is the silent React Native factor (no user presence);
 * `hardware` is the React Native factor that proves presence — the kernel shows the system
 * verification prompt with text it renders itself.
 */
export type UnlockFactor =
  | { readonly kind: "device" }
  | { readonly kind: "hardware" }
  | { readonly kind: "passkey" }
  | { readonly kind: "password"; readonly password: string };

/**
 * A factor the user proves again for a guarded operation — `device` can never verify: it proves no
 * user presence.
 */
export type VerifyFactor = Exclude<UnlockFactor, { readonly kind: "device" }>;

/**
 * A factor being created; `name` is the passkey credential's display name — the host validates it
 * before the ceremony (1–64 characters). React Native hosts choose their own vault factors, so an
 * initial factor exists only on hosts without a platform keystore.
 */
export type InitialFactor =
  | { readonly kind: "passkey"; readonly name: string }
  | { readonly kind: "password"; readonly password: string };

/**
 * WebAuthn RP identity + PRF salt labels the host configures once. `rpId`, `walletSalt` and
 * `vaultSalt` are permanent identifiers: changing any of them makes every existing passkey factor
 * and passkey-derived wallet unrecoverable, and the two salts must differ. Moving a wallet to a
 * different domain requires WebAuthn related origins (`/.well-known/webauthn`); hosts should offer
 * `exportMnemonic` for passkey-derived wallets so they survive an RP migration.
 *
 * The `rpId` scope is the wallet's trust boundary. WebAuthn binds a credential, and its PRF, to the
 * RP id, not to one origin: a script on any origin that may claim this RP id — every subdomain of
 * it, every related origin, every associated app — can evaluate the PRF over `walletSalt` and
 * derive the seed of a passkey wallet from one ordinary-looking passkey prompt.
 */
export type PasskeyConfig = {
  /**
   * RP id — a domain that serves nothing but the wallet (e.g. `wallet.example.com`), never a
   * registrable parent shared with other content.
   */
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

export type NativeAutoLockPolicy = Extract<AutoLockPolicy, { readonly platform: "native" }>;

/** Public info for an imported private key — the record id, family and address. */
export type KeyInfo = {
  readonly keyId: string;
  readonly family: "evm" | "solana" | "bitcoin" | "tron";
  readonly address: string;
  readonly createdAt: number;
};

/** The `wallet.keys` facade — import/list/remove/export for single private keys. */
export type KeysApi = {
  /**
   * `secret` is the family's canonical encoding: `0x`-prefixed 64-hex or 32 bytes for EVM; base58
   * or raw bytes for a Solana 32-byte seed or 64-byte keypair; bare 64-hex or 32 bytes for TRON.
   */
  readonly import: (
    family: "evm" | "solana" | "bitcoin" | "tron",
    secret: string | Uint8Array,
  ) => Promise<KeyInfo>;
  readonly list: () => Promise<ReadonlyArray<KeyInfo>>;
  readonly remove: (keyId: string, verify: VerifyFactor) => Promise<void>;
  readonly export: (keyId: string, verify: VerifyFactor) => Promise<Uint8Array>;
};

export type WalletSnapshot = {
  readonly vault: VaultState;
  readonly lockReason: LockReason | undefined;
  readonly verifying: boolean; // a user verification is in flight
  /** Established vault without a device factor: every unlock verifies (native app lock). */
  readonly appLock: boolean;
  /** Whether any presence-proving factor exists on this vault. */
  readonly verification: "available" | "unavailable";
  readonly factors: ReadonlyArray<FactorInfo>;
  readonly wallets: ReadonlyArray<WalletInfo>;
  readonly nostr: { readonly keys: ReadonlyArray<NostrKeyInfo> };
  readonly importedKeys: ReadonlyArray<KeyInfo>;
  /** The retained backup key's public id, or null when cloud backup is off. */
  // oxlint-disable-next-line typescript/no-restricted-types -- wire contract: backup is null when off
  readonly backup: BackupInfo | null;
  /**
   * Whether the vault signs requests the chain decoder marks blind — content it cannot show or
   * bound.
   */
  readonly blindSigning: boolean;
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
  ) => Promise<VaultWalletInfo>;
  readonly discard: () => Promise<void>;
};

export type VaultApi = {
  readonly unlock: (factor?: UnlockFactor) => Promise<void>;
  readonly lock: () => Promise<void>;
  readonly addFactor: (factor: InitialFactor, verify: VerifyFactor) => Promise<FactorInfo>;
  readonly removeFactor: (id: string, verify: VerifyFactor) => Promise<void>; // ≥1 factor remains
  /** Registers the verifying (hardware) factor on a native vault that has none — no prior verify. */
  readonly enrolVerification: () => Promise<void>;
  /** Turns the native app lock on (drops the silent device factor) or off (restores it). */
  readonly setAppLock: (enabled: boolean, verify: VerifyFactor) => Promise<void>;
  /**
   * Allows or refuses blind signing: the requests the chain decoder marks blind — raw-byte
   * messages, typed data too large or misformed to show, an unrecognised function of a listed
   * token, calldata that runs the signing account's own code, or a Safe delegatecall or unbounded
   * refund. Off on a new vault; while off such a request fails with `blind-signing-disabled` before
   * any verification prompt. Requests the wallet can describe but not verify sign without the
   * setting.
   */
  readonly setBlindSigning: (enabled: boolean, verify: VerifyFactor) => Promise<void>;
  readonly reset: () => Promise<void>;
};

export type WalletsApi = {
  readonly createWithPasskey: (options: {
    /** Display name for the new passkey credential (1–64 characters after trimming). */
    readonly name: string;
    readonly factor?: InitialFactor;
  }) => Promise<VaultWalletInfo>;
  readonly restoreWithPasskey: (options?: {
    readonly factor?: InitialFactor;
  }) => Promise<VaultWalletInfo>;
  readonly createMnemonic: (options: {
    readonly words: 12 | 24;
    readonly factor?: InitialFactor;
  }) => Promise<MnemonicDraft>;
  readonly importMnemonic: (options: {
    readonly mnemonic: string;
    /** BIP-39 passphrase; omit or pass "" for none. Spaces are significant. */
    readonly passphrase?: string;
    readonly factor?: InitialFactor;
  }) => Promise<VaultWalletInfo>;
  /** One-shot mnemonic (and passphrase) export; requires re-verification every call. */
  readonly exportMnemonic: (walletId: string, verify: VerifyFactor) => Promise<ExportedMnemonic>;
  readonly delete: (walletId: string, verify: VerifyFactor) => Promise<void>;
};

export type DataKeyApi = {
  readonly get: (purpose: string) => Promise<Uint8Array>;
};

/**
 * Cloud-backup entry points. `enable` re-verifies and retains a fresh BEK in the vault; `update`
 * rewrites the sealed envelope JSON with the retained BEK (no factor ceremony, so an auto-sync can
 * run silently); `disable` re-verifies and drops the retained BEK; `restore` merges an envelope
 * into the vault. Factor inputs reuse `UnlockFactor` — passkey assertions evaluate the PRF over
 * `backupSalt`.
 */
export type BackupApi = {
  readonly enable: (options: {
    readonly verify: VerifyFactor;
    readonly factors: ReadonlyArray<UnlockFactor>;
  }) => Promise<void>;
  readonly update: () => Promise<string>;
  readonly disable: (verify: VerifyFactor) => Promise<void>;
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
    readonly wallets: ReadonlyArray<VaultWalletInfo>;
    readonly passphraseRequired: ReadonlyArray<string>;
  }>;
};

/**
 * One running signer operation (card or device): `observe` replays the current step first, then
 * every step the kernel reports; `cancel` is idempotent and resolves once the kernel answered the
 * cancellation; `result` resolves with the operation's result or rejects —
 * `WalletError("cancelled")` after a cancel.
 */
export type SignerTask<Step, Result> = {
  readonly observe: (listener: (step: Step) => void) => () => void;
  readonly cancel: () => Promise<void>;
  readonly result: Promise<Result>;
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
