import type { SparkCrypto } from "@qntx/spark/crypto";
import type { ProtocolValue } from "@qntx/wallet/protocol";
/**
 * Platform capabilities injected by the host packages. The kernel holds no ambient singletons and
 * imports no platform APIs; every capability arrives through these types.
 */
import type { NostrBackend } from "./modules/nostr/backend.ts";
import type { RecordStore } from "./vault/store.ts";
/** Returns `length` cryptographically random bytes. */
export type Random = (length: number) => Uint8Array;
export type Pbkdf2 = (hash: "sha256" | "sha512", password: Uint8Array, salt: Uint8Array, iterations: number, length: number) => Promise<Uint8Array>;
/** Session limits owned by the worker entry (Web and Node: idle 5/15/60 min, max 12 h). */
export type KernelPolicy = {
    readonly maxSessionMs: number;
    /** Upper bound for ncryptsec imports; enforced by the nostr module. */
    readonly maxScryptLogN: number;
    /**
     * Idle lock. Absent on hosts that never idle-lock in the foreground (native locks on
     * backgrounding instead): the session then ends only at `maxSessionMs`. "presence" counts only
     * user-presence-bearing methods (web — background traffic must not hold a session open);
     * "request" counts every successful request (node — there is no human to observe).
     */
    readonly idle?: {
        readonly ms: number;
        readonly activity: "presence" | "request";
    } | undefined;
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
    readonly store: RecordStore;
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
 * The platform keystore contract (W5): a hardware-backed sealer that owns the vault factor's KEK.
 * `seal` creates the key alias `id` and encrypts `secret` under it after a user-presence prompt;
 * `open` decrypts after the same presence check; `authenticate` only proves the device owner is
 * present (reset); `clear` deletes every vault key this app created. The host rejects with
 * KernelError codes `cancelled` | `factor-invalidated` | `factor-unavailable` | `unavailable`.
 */
export type Keystore = {
    readonly locale: string;
    readonly seal: (id: string, secret: Uint8Array, prompt: KeystorePrompt) => Promise<Uint8Array>;
    readonly open: (id: string, sealed: Uint8Array, prompt: KeystorePrompt) => Promise<Uint8Array>;
    readonly authenticate: (prompt: KeystorePrompt) => Promise<void>;
    readonly clear: () => Promise<void>;
};
/** PRF inputs of one ceremony: at most two evaluations (WebAuthn `prf.eval`). */
export type PrfSalts = {
    readonly first: Uint8Array;
    readonly second?: Uint8Array;
};
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
 * extension. The host rejects with KernelError codes `cancelled` | `factor-unavailable` (no PRF
 * support, unconfigured associated domain) | `unavailable`.
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
/** The platform authenticator, or `factor-unavailable` where the host runs ceremonies. */
export declare function requirePasskey(platform: KernelPlatform): PasskeyAuthenticator;
/**
 * Serializes every system-UI ceremony — keystore seal/open/authenticate/clear and passkey
 * create/get share one queue, because the platform can show only one verification at a time. A
 * rejection does not wedge the queue. Applied once by `startKernel`.
 */
export declare function serializeCeremonies(platform: KernelPlatform): KernelPlatform;
/**
 * Factor-kind gate by platform: a keystore host (RN) takes only `hardware` vault factors — a
 * password there would let a compromised main runtime satisfy per-operation verification without
 * the system prompt — and a host without one (web/node) takes only `password`/`passkey`. Backup
 * factors are exempt.
 */
export declare function assertFactorKindAvailable(platform: KernelPlatform, kind: "hardware" | "password" | "passkey"): void;
/** The platform keystore, or `factor-unavailable` on hosts without secure hardware. */
export declare function requireKeystore(platform: KernelPlatform): Keystore;
/**
 * One direction of the host↔kernel channel. `post` may move the listed ArrayBuffers (transferable
 * secret bytes); `listen` returns an unsubscribe function. The RN host encodes ProtocolValue as
 * CBOR; Web/Node pass it through structured clone.
 */
export type Port = {
    readonly post: (message: ProtocolValue, transfer: ArrayBuffer[]) => void;
    readonly listen: (handler: (message: unknown) => void) => () => void;
};
