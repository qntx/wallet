import type { LockReason } from "@qntx/wallet/types";
import type { KernelPlatform } from "../platform.ts";
import type { Secret } from "../secret/secret.ts";
/**
 * Factor material resolved while creating a wallet on an uninitialized vault. A software KEK is
 * expensive (600k PBKDF2) or single-use (PRF), so it is derived once at `createMnemonic` and held
 * in the draft until `confirm`/`discard`/`lock`. A hardware factor holds nothing: its key is
 * created at `confirm`, so a discarded draft leaves no key behind.
 */
export type PendingFactor = {
    readonly kind: "hardware";
} | {
    readonly kind: "password";
    readonly kek: Secret;
    readonly salt: Uint8Array;
} | {
    readonly kind: "passkey";
    readonly kek: Secret;
    readonly credentialId: Uint8Array;
};
/** An in-flight mnemonic ceremony: entropy plus the expected quiz answers. Lock discards all. */
export type MnemonicDraft = {
    readonly entropy: Secret;
    readonly words: 12 | 24;
    readonly quiz: readonly [number, number, number];
    readonly expected: ReadonlyArray<Uint8Array>;
    readonly pendingFactor: PendingFactor | undefined;
};
export declare function wipePendingFactor(pending: PendingFactor): void;
export declare function wipeDraft(draft: MnemonicDraft): void;
/**
 * Session state machine: uninitialized | locked | unlocked. Timeout checks run at the start of
 * every request (the authoritative path); the injected `platform.setTimer` additionally locks
 * proactively so a quiet Worker still locks on time.
 */
export declare class Session {
    private state;
    private readonly drafts;
    private cancelTimer;
    private readonly platform;
    private readonly onLock;
    constructor(platform: KernelPlatform, onLock: (reason: LockReason) => void);
    get status(): "uninitialized" | "locked" | "unlocked";
    get unlocked(): boolean;
    /** Called once the initial store image is loaded and after every external change. */
    setInitialized(initialized: boolean): void;
    /** Opens a session, replacing any existing one. Returns the new session id. */
    open(dek: Secret, keyId: string): string;
    /** Swaps the live DEK after a rotation commit (old DEK wiped); throws `locked` when not unlocked. */
    rotate(dek: Secret, keyId: string): void;
    /**
     * Enforces idle and max-session deadlines on the monotonic elapsed clock. Returns the lock reason
     * when the session expired; the caller locks before handling the request. Pure check — activity
     * is stamped by `touch()` on a successful request, never here.
     */
    checkTimeouts(): LockReason | undefined;
    /**
     * Stamps user activity: the idle deadline moves forward and the timer re-arms. The max-session
     * deadline never moves — `schedule()` still clamps to it.
     */
    touch(): void;
    /** The live session for a request that carries `session`; throws `locked` on any mismatch. */
    require(requestSession: string | undefined): {
        id: string;
        dek: Secret;
    };
    /** The live session without a request-id check (drafts prove same-process provenance). */
    current(): {
        id: string;
        dek: Secret;
        keyId: string;
    };
    putDraft(id: string, draft: MnemonicDraft): void;
    takeDraft(id: string): MnemonicDraft;
    /** Peek without removing: a wrong quiz answer keeps the draft. */
    getDraft(id: string): MnemonicDraft;
    dropDraft(id: string): void;
    lock(reason: LockReason): void;
    private wipeUnlocked;
    private schedule;
}
