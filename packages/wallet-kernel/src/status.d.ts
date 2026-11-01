import type { BackupInfo, NullValue } from "@qntx/wallet/protocol";
import type { FactorInfo, NostrKeyInfo, StatusPayload, WalletInfo } from "@qntx/wallet/types";
import type { KernelContext, VaultHooks } from "./commands/context.ts";
import type { NostrModule } from "./modules/nostr/index.ts";
import type { VaultImage } from "./vault/store.ts";
/** The kernel's read on a loaded vault image; `unavailable` never appears here (load threw). */
export type ImageHealth = "ok" | "corrupted" | "unsupported";
/**
 * Snapshot contents for the `status` payload — the record-ownership composition point, and the
 * image's health assessment. The core parses the kinds it owns (entropy, data-key), claimed records
 * are partitioned per module and each module's own status function is called explicitly. An
 * unclaimed kind or a newer format marks the vault `unsupported` — the data stays untouched and the
 * user must update; a malformed known header marks it `corrupted`. Locked snapshots are
 * display-only data from unauthenticated public headers.
 */
export declare function statusContents(image: VaultImage, modules: ReadonlyArray<VaultHooks>, nostr: NostrModule): {
    factors: FactorInfo[];
    wallets: WalletInfo[];
    keys: ReadonlyArray<NostrKeyInfo>;
    backup: BackupInfo | NullValue;
    health: ImageHealth;
};
/** The `status` payload for the current session + image; shared by `status` and `postStatus`. */
export declare function statusPayload(ctx: KernelContext, nostr: NostrModule): StatusPayload;
