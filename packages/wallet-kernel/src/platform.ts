import type { SparkCrypto } from "@qntx/spark/crypto";
import type { Factor, ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "./errors.ts";
/**
 * Platform capabilities injected by the host packages. The kernel holds no ambient singletons and
 * imports no platform APIs; every capability arrives through these types.
 */
import type { Anchor } from "./modules/card/protocol/identity.ts";
import type { NostrBackend } from "./modules/nostr/backend.ts";
import type { RecordStore } from "./vault/store.ts";

/** Returns `length` cryptographically random bytes. */
export type Random = (length: number) => Uint8Array;

export type Pbkdf2 = (
  hash: "sha256" | "sha512",
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
) => Promise<Uint8Array>;

/** Argon2 cost: memory in KiB, passes over it, and lanes (RFC 9106 `m`, `t`, `p`). */
export type Argon2Cost = {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly lanes: number;
};

/** Argon2id version 0x13 with no secret and no associated data. */
export type Argon2id = (
  password: Uint8Array,
  salt: Uint8Array,
  cost: Argon2Cost,
  length: number,
) => Promise<Uint8Array>;

/**
 * A few bytes of vault state the kernel keeps outside the record store, where a store writer who
 * puts an older vault image back cannot put this back too (hosts: RN platform keystore, Web Cache
 * Storage partition, Node main-thread memory). Written only by the kernel.
 */
export type VaultAnchor = {
  readonly read: () => Promise<Uint8Array | undefined>;
  /**
   * Atomic compare-and-swap: writes `next` only when the stored bytes equal `expected` (undefined =
   * nothing stored); false, writing nothing, otherwise.
   */
  readonly replace: (next: Uint8Array, expected: Uint8Array | undefined) => Promise<boolean>;
};

/**
 * Session limits owned by the worker entry (Web and Node: idle 5/15/60 min, max 12 h; native: 15
 * min presence idle, max 24 h).
 */
export type KernelPolicy = {
  readonly maxSessionMs: number;
  /** Upper bound for ncryptsec imports; enforced by the nostr module. */
  readonly maxScryptLogN: number;
  /**
   * Idle lock. "presence" counts only user-presence-bearing methods, so background traffic or a
   * signing session cannot hold the vault open (Web, native); "request" counts every successful
   * request (node — there is no human to observe). Absent: the session ends only at
   * `maxSessionMs`.
   */
  readonly idle?:
    | {
        readonly ms: number;
        readonly activity: "presence" | "request";
      }
    | undefined;
};

/**
 * Schedules `fn` after `delayMs` and returns a cancel function. Injected because bare Hermes has no
 * timer globals; on Web/Node the host passes `setTimeout`/`clearTimeout`.
 */
export type SetTimer = (delayMs: number, fn: () => void) => () => void;

export type KernelPlatform = {
  readonly random: Random;
  /** Milliseconds since the epoch, for persisted timestamps only (createdAt, lastFailureAt). */
  readonly now: () => number;
  /**
   * Monotonic elapsed milliseconds (Web/Node: `performance.now()`); session deadlines are measured
   * on this clock so a wall-clock jump can never extend or shorten a session.
   */
  readonly elapsed: () => number;
  readonly setTimer: SetTimer;
  readonly pbkdf2: Pbkdf2;
  /** Memory-hard KDF for secrets an attacker can take offline: the cloud-backup password. */
  readonly argon2id: Argon2id;
  readonly store: RecordStore;
  /**
   * Vault state kept outside `store`: the revision floor and the password failure counters, where a
   * writer of the store alone cannot roll them back (see vault/anchor.ts).
   */
  readonly anchor: VaultAnchor;
  readonly policy: KernelPolicy;
  /**
   * The device keystore — present only on hosts with secure hardware (RN). `undefined` on web/node.
   * When present, the only vault factor kind is `hardware`; when absent, only `password`/`passkey`
   * — enforced by the kernel at every factor entry.
   */
  readonly keystore: Keystore | undefined;
  /**
   * The platform passkey authenticator — present only where the kernel runs WebAuthn ceremonies
   * itself (RN), so PRF outputs never pass through the main runtime. `undefined` on web/node, where
   * the host runs the ceremony and hands over the evidence.
   */
  readonly passkey: PasskeyAuthenticator | undefined;
  /** The card reader + secure input + trust anchors; `undefined` on hosts without NFC. */
  readonly card: CardPlatform | undefined;
  /**
   * The trusted secure-input view — present only where the kernel runs input ceremonies itself
   * (RN), so the cloud-backup password and the card's secrets never cross the main runtime.
   * `undefined` on web/node, where secrets arrive over the wire from the host's own UI.
   */
  readonly secureInput: SecureInput | undefined;
  /**
   * Heavy cryptographic backends the host supplies lazily. `spark` loads and verifies the wasm (or
   * native) SparkCrypto instance; the kernel calls it only when a spark.* method runs, so a
   * nostr-only session never loads it. Each call must return a backend the kernel keeps until a
   * WasmPoisonedError drops it; load failures reject (the kernel reports `unavailable`, a host's
   * own KernelError passes through — e.g. `integrity` on a hash mismatch).
   */
  readonly backends: {
    readonly spark: () => Promise<SparkCrypto>;
    /**
     * The nostr signing/verification/ECDH backend (WD-054). Required: the host wires noble or
     * native explicitly so no path silently falls back to the JS implementation. `Keys`/
     * `KeysSigner`/`createEventVerifier` get this object.
     */
    readonly nostr: NostrBackend;
  };
};

export type KeystorePrompt = {
  readonly title: string;
  readonly description: string;
};

/**
 * How one keystore operation protects its key. `device` seals and opens silently — the factor
 * exists so the vault can unlock without user presence. `presence` requires the system verification
 * prompt and carries the text the kernel renders.
 */
export type KeyUse =
  | { readonly protection: "device" }
  | { readonly protection: "presence"; readonly prompt: KeystorePrompt };

/**
 * The platform keystore contract (W5): a hardware-backed sealer that owns the vault factors' KEKs.
 * `seal` creates the key alias `id` and encrypts `secret` under it; `open` decrypts; `probe`
 * reports whether the key still exists without any UI; `remove` deletes one key; `authenticate`
 * only proves the device owner is present (reset); `clear` deletes every vault key this app
 * created. The host rejects with KernelError codes `cancelled` | `factor-invalidated` |
 * `verification-unavailable` | `unavailable`.
 */
export type Keystore = {
  readonly locale: string; // host-preferred BCP 47 language tag
  /** The OS the system prompt renders on; picks the kernel's prompt text bound. */
  readonly platform: "ios" | "android";
  readonly seal: (id: string, secret: Uint8Array, use: KeyUse) => Promise<Uint8Array>;
  readonly open: (id: string, sealed: Uint8Array, use: KeyUse) => Promise<Uint8Array>;
  /**
   * `false` only when key `id` is gone for good (deleted, permanently invalidated, or — for
   * presence keys — the lock screen is off); never shows UI. Any other failure rejects.
   */
  readonly probe: (id: string, protection: KeyUse["protection"]) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
  readonly authenticate: (prompt: KeystorePrompt) => Promise<void>;
  readonly clear: () => Promise<void>;
};

/** PRF inputs of one ceremony: at most two evaluations (WebAuthn `prf.eval`). */
export type PrfSalts = { readonly first: Uint8Array; readonly second?: Uint8Array };

/**
 * One ceremony's outcome. `first`/`second` are the PRF outputs (32 bytes each); a create may omit
 * them when the authenticator evaluates PRF only on assertion — the kernel then asserts once.
 * `synced`: the credential's backup-eligible and backed-up flags are both set. `userVerified`: the
 * UV flag of the authenticator data.
 */
export type PasskeyResult = {
  readonly credentialId: Uint8Array;
  readonly first: Uint8Array | undefined;
  readonly second: Uint8Array | undefined;
  readonly userHandle: Uint8Array | undefined;
  readonly synced: boolean;
  readonly userVerified: boolean;
};

/**
 * The platform passkey contract (W6): discoverable, user-verified credentials with the PRF
 * extension. The host rejects with KernelError codes `cancelled` | `passkey-not-configured` (no
 * credential provider set up) | `unsupported` (the platform cannot run ceremonies) |
 * `unavailable`.
 */
export type PasskeyAuthenticator = {
  readonly create: (input: {
    readonly rpId: string;
    readonly rpName: string;
    readonly userId: Uint8Array;
    readonly userName: string;
    readonly salts: PrfSalts;
  }) => Promise<PasskeyResult>;
  readonly get: (input: {
    readonly rpId: string;
    readonly allowCredentials: ReadonlyArray<Uint8Array> | undefined;
    readonly salts: PrfSalts;
  }) => Promise<PasskeyResult>;
};

/** The platform authenticator, or `unsupported` where the host runs ceremonies. */
export function requirePasskey(platform: KernelPlatform): PasskeyAuthenticator {
  if (platform.passkey === undefined) {
    throw new KernelError("unsupported", "this platform runs passkey ceremonies in the host");
  }
  return platform.passkey;
}

/**
 * Serializes every system-UI ceremony — presence keystore seal/open, authenticate, clear, passkey
 * create/get and secure-input requests share one queue, because the platform can show only one
 * verification at a time. Silent keystore work (device seal/open, probe, remove) bypasses the queue
 * and never fires `onCeremony`. A rejection does not wedge the queue. Applied once by
 * `startKernel`. `onCeremony` fires `true` when a ceremony's work starts and `false` when it
 * settles, strictly paired per queued call.
 */
export function serializeCeremonies(
  platform: KernelPlatform,
  onCeremony: (active: boolean) => void,
): KernelPlatform {
  let tail: Promise<void> = Promise.resolve();
  /** Takes the ceremony slot and returns its release — the base of `queue` and `reader.open`. */
  const acquire = async (): Promise<() => void> => {
    const previous = tail;
    let release: (() => void) | undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    onCeremony(true);
    let done = false;
    return () => {
      if (done) {
        return;
      }
      done = true;
      release?.();
      onCeremony(false);
    };
  };
  const queue = async <T>(work: () => Promise<T>): Promise<T> => {
    const release = await acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
  const { keystore, passkey, card, secureInput } = platform;
  // A reader session holds the ceremony slot from `open` until `close` (or a failed `open`) —
  // the platform's NFC sheet and the secure-input view are one surface.
  let releaseReader: (() => void) | undefined;
  const reader: CardReader | undefined =
    card === undefined
      ? undefined
      : {
          open: async (prompt) => {
            const release = await acquire();
            const result = await card.reader.open(prompt);
            if (!result.ok) {
              release();
              return result;
            }
            releaseReader = release;
            return result;
          },
          transmit: async (apdu) => card.reader.transmit(apdu),
          close: (outcome, text) => {
            card.reader.close(outcome, text);
            releaseReader?.();
            releaseReader = undefined;
          },
        };
  return {
    ...platform,
    card:
      card === undefined || reader === undefined
        ? card
        : {
            anchors: card.anchors,
            reader,
            ...(card.planMs === undefined ? {} : { planMs: card.planMs }),
          },
    keystore:
      keystore === undefined
        ? undefined
        : {
            locale: keystore.locale,
            platform: keystore.platform,
            seal: async (id, secret, use) =>
              use.protection === "presence"
                ? queue(async () => keystore.seal(id, secret, use))
                : keystore.seal(id, secret, use),
            open: async (id, sealed, use) =>
              use.protection === "presence"
                ? queue(async () => keystore.open(id, sealed, use))
                : keystore.open(id, sealed, use),
            probe: async (id, protection) => keystore.probe(id, protection),
            remove: async (id) => keystore.remove(id),
            authenticate: async (prompt) => queue(async () => keystore.authenticate(prompt)),
            clear: async () => queue(async () => keystore.clear()),
          },
    passkey:
      passkey === undefined
        ? undefined
        : {
            create: async (input) => queue(async () => passkey.create(input)),
            get: async (input) => queue(async () => passkey.get(input)),
          },
    secureInput:
      secureInput === undefined
        ? undefined
        : {
            /* A request made while the kernel's own reader session holds the slot runs inside
               that slot — the session already owns the surface and a queue would deadlock on
               itself. Everything else takes the queue. */
            request: async (kind, label) =>
              releaseReader === undefined
                ? queue(async () => secureInput.request(kind, label))
                : secureInput.request(kind, label),
            cancel: () => {
              secureInput.cancel();
            },
          },
  };
}

/**
 * Factor-kind gate by platform: a keystore host (RN) takes only `device`/`hardware` vault factors —
 * a password there would let a compromised main runtime satisfy per-operation verification without
 * the system prompt — and a host without one (web/node) takes only `password`/`passkey`. Backup
 * factors are exempt.
 */
export function assertFactorKindAvailable(
  platform: KernelPlatform,
  kind: "device" | "hardware" | "password" | "passkey",
): void {
  const native = kind === "device" || kind === "hardware";
  if ((platform.keystore !== undefined) !== native) {
    throw new KernelError("unsupported", "this factor kind is not available here");
  }
}

/**
 * Gate for the factor a vault is established with: a keystore host always begins with the silent
 * `device` factor (the host then adds `hardware` itself when the device supports presence), and a
 * host without a keystore accepts `password`/`passkey` only.
 */
export function assertInitialFactor(platform: KernelPlatform, factor: Factor): void {
  const initial =
    platform.keystore === undefined
      ? factor.kind === "password" || factor.kind === "passkey"
      : factor.kind === "device";
  if (!initial) {
    throw new KernelError("unsupported", "this factor cannot establish a vault here");
  }
}

/** The platform keystore, or `unsupported` on hosts without secure hardware. */
export function requireKeystore(platform: KernelPlatform): Keystore {
  if (platform.keystore === undefined) {
    throw new KernelError("unsupported", "this platform has no hardware keystore");
  }
  return platform.keystore;
}

/**
 * One direction of the host↔kernel channel. `post` may move the listed ArrayBuffers (transferable
 * secret bytes); `listen` returns an unsubscribe function. The RN host encodes ProtocolValue as
 * CBOR; Web/Node pass it through structured clone.
 */
export type Port = {
  readonly post: (message: ProtocolValue, transfer: ArrayBuffer[]) => void;
  readonly listen: (handler: (message: unknown) => void) => () => void;
};

/**
 * Why a card-reader session ended without completing the current call. `cancelled` is the user
 * dismissing the session, `timeout` the platform's session window expiring, `tag-lost` the card
 * leaving the field, `interrupted` the platform interrupting the session — the reader surface lost
 * focus, the app left the foreground, or the system ended the session unexpectedly — and
 * `unavailable` anything else — including the reader being owned by another runtime or the platform
 * reporting an out-of-contract outcome.
 */
export type CardReaderFailure =
  | "cancelled"
  | "timeout"
  | "tag-lost"
  | "interrupted"
  | "unavailable";

/** The outcome of a card-reader call; `detail` is a `"<domain>:<code>"` diagnostic, never text. */
export type CardReaderResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly failure: CardReaderFailure;
      readonly detail: string | undefined;
    };

/**
 * The trusted NFC card-reader session. `open` shows `prompt` — trusted text only the kernel builds
 * — while the platform polls for an ISO-DEP card; the text is set once and cannot change
 * mid-session. `transmit` sends one APDU and resolves with the card's response data and its two
 * status bytes; only one transmit is in flight. Every failure ends the session. `close` ends it
 * with the shown outcome; a failure with an empty `text` closes silently. APDU bytes never cross
 * the main runtime.
 */
export type CardReader = {
  readonly open: (prompt: string) => Promise<CardReaderResult<undefined>>;
  readonly transmit: (apdu: Uint8Array) => Promise<CardReaderResult<Uint8Array>>;
  readonly close: (outcome: "success" | "failure", text: string) => void;
};

/**
 * What the secure input view collects: the qntx card's access code, its printed short ID, the
 * cloud-backup password — 1..1024 bytes of valid UTF-8, masked — or `session-approval`, a
 * kernel-chosen 4-digit confirmation code the label displays; the value is exactly 4 ASCII digits.
 */
export type SecureInputKind = "access-code" | "short-id" | "backup-password" | "session-approval";

/** The outcome of a secure-input request; `value` is the confirmed bytes the user entered. */
export type SecureInputResult =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly failure: "cancelled" | "unavailable" };

/**
 * The trusted secure-input surface. `request` asks the native view to collect `kind` — the view
 * shows `label` — and resolves with the entered bytes; the characters never cross the main runtime,
 * which only sees the view's state. Only one request exists at a time across runtimes. `cancel`
 * withdraws this runtime's pending request, resolving it `cancelled`.
 */
export type SecureInput = {
  readonly request: (kind: SecureInputKind, label: string) => Promise<SecureInputResult>;
  readonly cancel: () => void;
};

/**
 * The card capability bundle: reader session and the CA anchors the kernel trusts — input comes
 * through the top-level `secureInput`. Present only on hosts with an NFC card surface — `undefined`
 * on web/node, where every `card.*` method and every card-wallet seed lookup answers
 * `unsupported`.
 */
export type CardPlatform = {
  readonly reader: CardReader;
  readonly anchors: ReadonlyArray<Anchor>;
  /**
   * The host's real per-tap reader budget in ms — how long one card connection may run. iOS plans
   * 18 seconds per connection (§8); a host with a different reader budget sets it here. The kernel
   * plans each tap's commands inside this budget; when unset the protocol default applies.
   */
  readonly planMs?: number;
};
