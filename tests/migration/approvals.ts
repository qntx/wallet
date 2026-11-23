import type {
  ApprovalRow,
  ApprovalsView,
  PendingRequest,
  SolanaFeeTier,
  WalletEngine,
} from "@qntx/wallet-engine";

type Account = Parameters<WalletEngine["approvals"]["load"]>[0];

/**
 * The standing authorities over one account on one network. Every row was read on chain at
 * `view.at.height`; `exhaustive` names the kinds the chain itself enumerates — every other kind is
 * "known approvals" only, so show the discovery `sources` and their freshness next to the list.
 * Poll only while the screen is visible.
 */
export async function showApprovals(
  engine: WalletEngine,
  account: Account,
  network: string,
  render: (view: ApprovalsView) => void,
): Promise<() => void> {
  const key = await engine.approvals.load(account, network);
  engine.approvals.setVisible(true);
  const stop = engine.approvals.store.subscribe((state) => {
    const view = state.views[key];
    if (view !== undefined) {
      render(view);
    }
  });
  return () => {
    stop();
    engine.approvals.setVisible(false);
    engine.approvals.unload(key);
  };
}

/** Rows a single tap can remove; `none` rows (foreign close authority, …) are shown read-only. */
export const revocable = (view: ApprovalsView): ReadonlyArray<ApprovalRow> =>
  view.rows.filter((row) => row.revoke !== "none");

/**
 * Opens one ordinary request; approve it like any other. The row stays until the next chain read
 * after inclusion proves it gone. Prepare one request at a time: nonces are reserved at commit.
 */
export async function revokeRow(
  engine: WalletEngine,
  view: ApprovalsView,
  row: ApprovalRow,
  fee: SolanaFeeTier,
): Promise<PendingRequest> {
  return engine.approvals.revoke(view.key, row.id, fee);
}
