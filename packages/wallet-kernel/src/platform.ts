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

export type Pbkdf2 = (
  hash: "sha256" | "sha512",
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
) => Promise<Uint8Array>;

/** Session limits owned by the worker entry (Web and Node: idle 5/15/60 min, max 12 h). */
export type KernelPolicy = {
  readonly maxSessionMs: number;
  /** Upper bound for ncryptsec imports; enforced by the nostr module. */
  readonly maxScryptLogN: number;
  /**
   * Idle lock. Absent on hosts that never idle-lock in the foreground (native locks on
   * backgrounding instead): the session then ends only at `maxSessionMs`. "presence" counts
   * only user-presence-bearing methods (web — background traffic must not hold a session
   * open); "request" counts every successful request (node — there is no human to observe).
   */
  readonly idle?: {
    readonly ms: number;
    readonly activity: "presence" | "request";
  };
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

/**
 * One direction of the host↔kernel channel. `post` may move the listed ArrayBuffers (transferable
 * secret bytes); `listen` returns an unsubscribe function. The RN host encodes ProtocolValue as
 * CBOR; Web/Node pass it through structured clone.
 */
export type Port = {
  readonly post: (message: ProtocolValue, transfer: ArrayBuffer[]) => void;
  readonly listen: (handler: (message: unknown) => void) => () => void;
};
