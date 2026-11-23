import type { MethodName, ParamsOf, ResultOf } from "@qntx/wallet/protocol";

import type { KernelPlatform } from "../platform.ts";
import type { Secret } from "../secret/secret.ts";
import type { Session } from "../session/session.ts";
import type { StoreOp, StoredRecord, VaultImage } from "../vault/store.ts";
import type { OpenedRecord } from "../vault/vault.ts";

/**
 * The vault-facing hooks a protocol module implements, wired once in kernel.ts — an explicit
 * composition point, not a registry. The core iterates `KernelContext.modules` without knowing what
 * any module's records mean; status sections are composed separately in status.ts.
 */
export type VaultHooks = {
  /** Whether the module owns stored record `kind` — an unclaimed stored kind corrupts the vault. */
  readonly ownsRecord: (kind: string) => boolean;
  /**
   * Claims the module's plaintexts out of an unlock/reconcile pass. Claimed plaintexts are consumed
   * (the module wipes them into its own state); an entry that replaces a same-id one disposes the
   * old live state; the records it returns unclaimed are passed to the next module and finally
   * wiped by the caller.
   */
  readonly claimUnlocked: (records: ReadonlyArray<OpenedRecord>) => ReadonlyArray<OpenedRecord>;
  /** Drops the live state derived from a record the store no longer has. */
  readonly forget: (kind: string, id: string) => void;
  /** Lock bookkeeping: dispose every secret the module holds. */
  readonly lock: () => void;
  /**
   * The extra ops committed atomically when a wallet is deleted — the module's records derived from
   * that walletId. Live state follows the committed image through reconciliation, so no commit
   * bookkeeping is needed here.
   */
  readonly walletDeleteOps: (image: VaultImage, walletId: string) => ReadonlyArray<StoreOp>;
  /**
   * Throws when the public header of a record this module owns is malformed — status marks the
   * vault corrupted.
   */
  readonly parseHeader: (record: StoredRecord) => void;
};

/** Vault health, recomputed on every load; only ok serves the full method set. */
export type Health = "ok" | "corrupted" | "unsupported" | "unavailable";

/** Options for a commit sealed under a DEK other than the live session's. */
export type CommitOptions = {
  /** Swap the live session to a new DEK/keyId after the commit lands; wiped on failure. */
  readonly rotate?: { readonly dek: Secret; readonly keyId: string };
  /** The DEK of a vault being established — no session holds it yet. Not consumed. */
  readonly dek?: Secret;
};

/**
 * Services and state a command handler needs. `image` is replaced after every commit or external
 * change; `commit` writes, reloads `image`, and marks the status event dirty; `reload` refreshes
 * the image without writing.
 */
export type KernelContext = {
  readonly platform: KernelPlatform;
  readonly session: Session;
  readonly modules: ReadonlyArray<VaultHooks>;
  image: VaultImage;
  /**
   * The kernel's read on the store: "corrupted" (authentication or structure), "unsupported" (data
   * written by another build — left untouched) or "unavailable" (transient I/O). While non-ok only
   * `status` and `vault.reset` are served.
   */
  health: Health;
  /**
   * Atomically commits `ops`. Unless the commit is the `init`, carries `clear`, or is already
   * guarded, an `expect-revision` guard is prepended — a stale writer fails with `conflict` (the
   * image is reloaded best-effort before the error propagates). A commit that changes the vault's
   * structure also rewrites the manifest, sealed under the rotated DEK, the establishing DEK or the
   * live session's (`locked` without one). Non-KernelError failures map to `unavailable`. On
   * success the image reloads and `health` updates.
   */
  readonly commit: (ops: ReadonlyArray<StoreOp>, options?: CommitOptions) => Promise<void>;
  /** Reloads the store into `image` and recomputes `health`; throws the classified error. */
  readonly reload: () => Promise<void>;
  /**
   * Raises the vault anchor's floor to the loaded image's revision — only while the live session
   * holds an authenticated, healthy image (an unauthenticated one may never move the floor).
   */
  readonly raiseAnchor: () => Promise<void>;
  /**
   * Reconciles live module state from `prev` to the current `image` under the unlocked session: the
   * image must match its manifest, removed records are forgotten, added or changed rows are opened
   * with the session DEK and claimed by their module, and changed factor rows are bound-checked.
   * Any authentication failure latches `corrupted` and locks the session `invalidated`. A keyId
   * mismatch invalidates the session outright. No-op unless the session is unlocked.
   */
  readonly reconcile: (prev: VaultImage) => void;
};

/**
 * One typed handler per protocol method; `ParamsOf`/`ResultOf` come from the METHODS validators, so
 * a handler whose shape drifts from the table fails to typecheck. Params are validated once in
 * `dispatch`, generically, before the handler runs.
 */
export type Handler<M extends MethodName> = (
  ctx: KernelContext,
  params: ParamsOf<M>,
  session: string | undefined,
) => Promise<ResultOf<M>> | ResultOf<M>;
