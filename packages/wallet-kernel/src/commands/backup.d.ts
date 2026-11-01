import type { BackupFactor, Factor, NullValue } from "@qntx/wallet/protocol";
import type { WalletInfo } from "@qntx/wallet/types";
import type { KernelContext } from "./context.ts";
/**
 * Enables cloud backup: re-verify, mint a fresh BEK and retain it sealed in the `backup-key`
 * record. Re-enabling replaces the record — a new BEK (and id) so stale envelopes and leaked old
 * factors can never unwrap future backups.
 */
export declare function enableBackup(ctx: KernelContext, params: {
    verify: Factor;
    factors: ReadonlyArray<BackupFactor>;
}, requestSession: string | undefined): Promise<NullValue>;
/**
 * Rewrites the cloud envelope under the retained BEK: one fresh payload nonce, factor entries
 * copied verbatim from the backup-key header. No factor input — the envelope can only ever be
 * opened by the factors chosen at enable time.
 */
export declare function updateBackup(ctx: KernelContext, _params: NullValue, requestSession: string | undefined): {
    envelope: string;
};
/** Deletes the retained BEK; a missing record still succeeds. */
export declare function disableBackup(ctx: KernelContext, _params: NullValue, requestSession: string | undefined): Promise<NullValue>;
/**
 * Restore is a merge, never an overwrite: existing wallet and imported-key ids are skipped,
 * everything else goes down in one commit so a torn restore can't leave half the secrets.
 */
export declare function restoreBackup(ctx: KernelContext, params: {
    envelope: string;
    backupFactor: BackupFactor;
    factor?: Factor;
}, requestSession: string | undefined): Promise<{
    wallets: WalletInfo[];
    session: string;
}>;
