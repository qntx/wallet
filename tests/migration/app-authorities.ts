import type { AppAuthority, AppGroup, AppsController } from "@qntx/wallet-engine/apps";

/** A row of the venue-held-authorities panel: the authority, or the app whose read failed. */
export type AuthorityRow =
  | { readonly app: string; readonly authority: AppAuthority }
  | { readonly app: string; readonly failed: true };

/**
 * Every standing authority an app's venue holds over the group's funds, outside the approvals
 * inventory — the Hyperliquid builder fee lives on HyperCore. Display-only: `revoke` names how the
 * user removes it; `none` rows (the builder fee) need a venue-side action, not a wallet
 * transaction. Unlocked sessions only.
 */
export async function listAuthorities(
  apps: AppsController,
  group: AppGroup,
): Promise<ReadonlyArray<AuthorityRow>> {
  const rows = await apps.authorities(group);
  return rows.map((row) =>
    "authority" in row
      ? { app: row.app, authority: row.authority }
      : { app: row.app, failed: true as const },
  );
}
