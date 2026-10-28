import type { Event, Filter } from "@qntx/nostr";
import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import type { NostrKeyRef, WalletSigner } from "@qntx/wallet/nostr";

import type { AccountTreeController } from "../accounts/controller.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { decodeMetaDocBytes, encodeMetaDoc } from "./doc.ts";
import type { MetaSyncErrorCategory } from "./errors.ts";
import { MetaSyncError } from "./errors.ts";

export const META_SYNC_KIND = 30078;
const PUBLISH_DEBOUNCE_MS = 2000;

export type MetaSyncRelayPort = {
  readonly fetch: (filter: Filter) => Promise<ReadonlyArray<Event>>;
  readonly publish: (event: Event) => Promise<void>;
};

export type MetaSyncConfig = {
  /** The `d` tag that names this wallet's metadata document. */
  readonly tag: string;
  readonly relays: MetaSyncRelayPort;
};

export type MetaSyncWalletStatus = {
  readonly status: "unavailable" | "syncing" | "synced" | "error";
  readonly error?: MetaSyncErrorCategory;
};

export type MetaSyncState = {
  readonly wallets: Readonly<Record<string, MetaSyncWalletStatus>>;
};

export type MetaSyncControllerOptions = {
  readonly wallet: Wallet;
  readonly accounts: AccountTreeController;
  /** `nostr(wallet)` — the signer is requested per wallet for its group-0 derived key. */
  readonly nostr: { readonly signer: (ref: NostrKeyRef) => WalletSigner };
  readonly metaSync: MetaSyncConfig | undefined;
  readonly logger: EngineLogger;
  readonly now: () => number;
};

/**
 * Wallet-metadata sync over kind-30078 addressable events: one NIP-44-encrypted document per
 * wallet, authored by its group-0 derived key. Pull always precedes publish in an unlock session —
 * replaceable events would otherwise let a stale local tree overwrite a newer remote document.
 * Debounced publishes are per wallet; a generation counter cancels in-flight write-backs on lock.
 */
export class MetaSyncController extends Controller<MetaSyncState> {
  private readonly options: MetaSyncControllerOptions;
  private generation = 0;
  private readonly pulled = new Set<string>();
  private readonly lastRemoteCreatedAt = new Map<string, number>();
  private readonly lastExported = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<string>();
  private accountsUnsubscribe: (() => void) | undefined;

  constructor(options: MetaSyncControllerOptions) {
    super({ name: "metaSync", defaultState: () => ({ wallets: {} }) });
    this.options = options;
  }

  /** Unlocked: pull every wallet whose group-0 identity exists, then watch the tree. */
  async init(): Promise<void> {
    const gen = ++this.generation;
    this.accountsUnsubscribe = this.options.accounts.store.subscribe(() => {
      this.onTreeChange();
    });
    // pullAll covers every snapshot wallet at init — reconcile() is for additions later.
    await this.pullAll(gen);
  }

  async destroy(): Promise<void> {
    await this.lock();
  }

  /** Locked: cancel debounces and in-flight write-backs, forget the pull/publish bookkeeping. */
  async lock(): Promise<void> {
    this.generation += 1;
    this.accountsUnsubscribe?.();
    this.accountsUnsubscribe = undefined;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pulled.clear();
    this.lastRemoteCreatedAt.clear();
    this.lastExported.clear();
    this.inflight.clear();
    this.update(() => ({ wallets: {} }));
    await Promise.resolve();
  }

  /** Snapshot changed while unlocked: pull newly-seen wallets, drop removed ones. */
  reconcile(): void {
    if (this.options.metaSync === undefined) {
      return;
    }
    const snap = this.options.wallet.getSnapshot();
    const live = new Set(snap.wallets.map((w) => w.walletId));
    const gen = this.generation;
    for (const w of snap.wallets) {
      if (this.getState().wallets[w.walletId] === undefined) {
        void this.pullOne(w.walletId, gen);
      }
    }
    this.update((s) => {
      const wallets = Object.fromEntries(
        Object.entries(s.wallets).filter(([walletId]) => live.has(walletId)),
      );
      return { ...s, wallets };
    });
  }

  /** Manual re-pull of every wallet that can sync. */
  async sync(): Promise<void> {
    await this.pullAll(this.generation);
  }

  private async pullAll(gen: number): Promise<void> {
    const snap = this.options.wallet.getSnapshot();
    await Promise.all(snap.wallets.map(async (w) => this.pullOne(w.walletId, gen)));
  }

  private async pubkeyFor(signer: WalletSigner): Promise<string> {
    return signer.getPublicKey();
  }

  private signerFor(walletId: string): WalletSigner | undefined {
    const snap = this.options.wallet.getSnapshot();
    const ref = { kind: "derived" as const, walletId, groupIndex: 0 };
    const hasKey = snap.nostr.keys.some(
      (k) => k.ref.kind === "derived" && k.ref.walletId === walletId && k.ref.groupIndex === 0,
    );
    if (!hasKey) {
      return undefined;
    }
    return this.options.nostr.signer(ref);
  }

  private setStatus(walletId: string, status: MetaSyncWalletStatus): void {
    this.update((s) => ({ ...s, wallets: { ...s.wallets, [walletId]: status } }));
  }

  private async pullOne(walletId: string, gen: number): Promise<void> {
    const config = this.options.metaSync;
    if (config === undefined || this.inflight.has(walletId)) {
      return;
    }
    const signer = this.signerFor(walletId);
    if (signer === undefined) {
      if (gen === this.generation) {
        this.setStatus(walletId, { status: "unavailable" });
      }
      return;
    }
    this.inflight.add(walletId);
    this.setStatus(walletId, { status: "syncing" });
    try {
      const pubkey = await this.pubkeyFor(signer);
      const events = await config.relays.fetch(this.filterFor(pubkey, config.tag));
      let remote: Event | undefined;
      let remoteSkipped = 0;
      for (const e of events) {
        if (!this.acceptableEvent(e, pubkey, config.tag)) {
          remoteSkipped += 1;
          continue;
        }
        if (remote === undefined || e.created_at > remote.created_at) {
          remote = e;
        }
      }
      if (remote === undefined) {
        // No doc on the relay: publish only when the local tree holds a real edit
        // (updatedAt > 0) — a fresh device must not replace nothing with empty defaults.
        const local = this.options.accounts.exportMeta(walletId);
        const hasEdits = local.wallet.updatedAt > 0 || local.groups.some((g) => g.updatedAt > 0);
        if (gen !== this.generation) {
          return;
        }
        this.pulled.add(walletId);
        this.rememberExport(walletId);
        this.setStatus(walletId, { status: "synced" });
        if (hasEdits) {
          await this.publishNow(walletId, gen);
        }
      } else {
        // A verified event we cannot read must never be overwritten — a newer app version
        // (e.g. v: 2) is the most likely cause; decode failure is data corruption.
        const decrypt = signer.nip44Decrypt;
        const plaintext =
          decrypt === undefined
            ? undefined
            : await decrypt.call(signer, pubkey, remote.content).catch(() => undefined);
        const doc =
          plaintext === undefined
            ? undefined
            : decodeMetaDocBytes(new TextEncoder().encode(plaintext));
        if (doc === undefined) {
          if (gen !== this.generation) {
            return;
          }
          const error: MetaSyncErrorCategory =
            plaintext !== undefined && isUnsupportedDoc(plaintext) ? "unsupported" : "corrupt";
          this.setStatus(walletId, { status: "error", error });
          this.options.logger.warn(`meta sync: unreadable remote doc (${error})`);
          return; // not in `pulled` — debounced publishes stay blocked too
        }
        const merge = this.options.accounts.mergeMeta(walletId, doc);
        if (gen !== this.generation) {
          return;
        }
        this.lastRemoteCreatedAt.set(walletId, remote.created_at);
        this.pulled.add(walletId);
        this.rememberExport(walletId);
        this.setStatus(walletId, { status: "synced" });
        if (merge.localNewer) {
          await this.publishNow(walletId, gen);
        }
      }
      if (remoteSkipped > 0) {
        this.options.logger.warn(`meta sync: ignored ${remoteSkipped} invalid remote events`);
      }
    } catch (error) {
      if (gen === this.generation) {
        this.setStatus(walletId, { status: "error", error: categorizeSync(error) });
        this.options.logger.warn("meta sync pull failed", error);
      }
    } finally {
      this.inflight.delete(walletId);
    }
  }

  private filterFor(pubkey: string, tag: string): Filter {
    return { kinds: [META_SYNC_KIND], authors: [pubkey], "#d": [tag] };
  }

  private acceptableEvent(e: Event, pubkey: string, tag: string): boolean {
    if (e.kind !== META_SYNC_KIND || e.pubkey !== pubkey || !verifyEvent(e)) {
      return false;
    }
    const dTags = e.tags.filter((t) => t[0] === "d");
    return dTags.length === 1 && dTags[0]?.[1] === tag;
  }

  /** Snapshot the wallet's exported doc — the debounce publishes only on a real change. */
  private rememberExport(walletId: string): void {
    try {
      const doc = this.options.accounts.exportMeta(walletId);
      this.lastExported.set(walletId, JSON.stringify(doc));
    } catch {
      // Wallet not in the tree — nothing to remember.
    }
  }

  private onTreeChange(): void {
    if (this.options.metaSync === undefined) {
      return;
    }
    for (const walletId of this.pulled) {
      let current: string | undefined;
      try {
        current = JSON.stringify(this.options.accounts.exportMeta(walletId));
      } catch {
        continue;
      }
      if (current === this.lastExported.get(walletId)) {
        continue;
      }
      this.lastExported.set(walletId, current);
      const existing = this.timers.get(walletId);
      if (existing !== undefined) {
        clearTimeout(existing);
      }
      const gen = this.generation;
      this.timers.set(
        walletId,
        setTimeout(() => {
          this.timers.delete(walletId);
          void this.publishNow(walletId, gen);
        }, PUBLISH_DEBOUNCE_MS),
      );
    }
  }

  private async publishNow(walletId: string, gen: number): Promise<void> {
    const config = this.options.metaSync;
    if (config === undefined || !this.pulled.has(walletId)) {
      return;
    }
    const signer = this.signerFor(walletId);
    if (signer === undefined) {
      this.setStatus(walletId, { status: "unavailable" });
      return;
    }
    try {
      const doc = this.options.accounts.exportMeta(walletId);
      const bytes = encodeMetaDoc(doc);
      if (bytes === undefined) {
        throw new MetaSyncError("internal", "meta doc exceeds 64 KB");
      }
      const encrypt = signer.nip44Encrypt;
      if (encrypt === undefined) {
        throw new MetaSyncError("internal", "signer lacks nip44 encryption");
      }
      const pubkey = await this.pubkeyFor(signer);
      const content = await encrypt.call(signer, pubkey, new TextDecoder().decode(bytes));
      const lastRemote = this.lastRemoteCreatedAt.get(walletId) ?? 0;
      const created_at = Math.max(Math.floor(this.options.now() / 1000), lastRemote + 1);
      const event = await signer.signEvent({
        pubkey,
        kind: META_SYNC_KIND,
        created_at,
        tags: [["d", config.tag]],
        content,
      });
      if (gen !== this.generation) {
        return;
      }
      await config.relays.publish(event);
    } catch (error) {
      if (gen === this.generation) {
        this.setStatus(walletId, { status: "error", error: categorizeSync(error) });
        this.options.logger.warn("meta sync publish failed", error);
      }
    }
  }
}

function categorizeSync(error: unknown): MetaSyncErrorCategory {
  return error instanceof MetaSyncError ? error.category : "network";
}

/** A decrypted doc that parses as JSON with a numeric `v` above 1 is a newer schema, not garbage. */
function isUnsupportedDoc(plaintext: string): boolean {
  try {
    const doc: unknown = JSON.parse(plaintext);
    return (
      typeof doc === "object" &&
      doc !== null &&
      "v" in doc &&
      typeof doc.v === "number" &&
      doc.v > 1
    );
  } catch {
    return false;
  }
}
