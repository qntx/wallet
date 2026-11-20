import type { GroupHistory, WalletEngine } from "@qntx/wallet-engine";

/**
 * One newest-first activity list per account group, incoming transfers included. State is keyed
 * `${walletId}:${groupIndex}`; `loadMore` pages older entries while `hasMore`. `gaps` names the
 * networks whose provider pages dropped entries — render a gap notice while it is non-empty.
 */
export function showActivity(
  engine: WalletEngine,
  group: { readonly walletId: string; readonly groupIndex: number },
  render: (history: GroupHistory, gaps: ReadonlyArray<string>) => void,
): () => void {
  const key = `${group.walletId}:${String(group.groupIndex)}`;
  const stop = engine.history.store.subscribe((state) => {
    const history = state.groups[key];
    if (history !== undefined) {
      render(history, history.truncated);
    }
  });
  void engine.history.load(group);
  return stop;
}

export async function showOlder(
  engine: WalletEngine,
  group: { readonly walletId: string; readonly groupIndex: number },
): Promise<void> {
  await engine.history.loadMore(group);
}
